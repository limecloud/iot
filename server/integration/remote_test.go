package integration

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/limecloud/iot/server/internal/control"
	"github.com/limecloud/iot/server/internal/mysqlstore"
)

func testRemoteDurability(t *testing.T, store *mysqlstore.Store) {
	ctx := context.Background()
	cfg := control.Config{Mode: "private", Key: make([]byte, 32), Logins: map[string]control.LoginConfig{"console": {LocalToken: control.Random()}, "admin": {LocalToken: control.Random()}}}
	server, cfg := newApp(t, store, cfg)
	c := newClient(t, server.URL)
	c.login("console", cfg.Logins["console"].LocalToken)
	space := decode[control.Space](t, c.call("POST", "/api/console/v1/spaces", map[string]string{"request_key": control.Random(), "name": "远程耐久测试"}, 200))
	pair := c.pair(space.ID, "remote-pair")
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	claim := sign(server.URL, pair.Pairing, key, "local-remote")
	claim.Code = pair.Code
	binding := decode[control.Gateway](t, c.call("POST", "/api/pairing/v1/"+pair.Pairing.ID+"/claim", claim, 200))
	input := control.RemoteInput{Key: "original", GatewayID: binding.ID, Revision: binding.Revision, DeviceID: "device-lamp", ModelRevision: "sha256:" + control.Hash("model"), Expires: time.Now().UTC().Add(25 * time.Second), Operation: control.RemoteOperation{Type: "property.set", Path: "light.power", Value: json.RawMessage(`true`)}}
	digest, err := control.CanonicalDigest(input)
	if err != nil {
		t.Fatal(err)
	}
	expected := control.RemoteCommand{ID: "remote-" + control.Random(), SpaceID: space.ID, PrincipalID: binding.PrincipalID, Input: input, Digest: digest}
	var wg sync.WaitGroup
	created := make(chan bool, 8)
	results := make(chan control.RemoteCommand, 8)
	failures := make(chan error, 8)
	for range 8 {
		wg.Go(func() {
			v := expected
			v.ID = "remote-" + control.Random()
			got, fresh, err := store.ReserveRemote(ctx, v)
			created <- fresh
			results <- got
			failures <- err
		})
	}
	wg.Wait()
	close(created)
	close(results)
	close(failures)
	count := 0
	for fresh := range created {
		if fresh {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("concurrent sends reserved %d intents", count)
	}
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	var original control.RemoteCommand
	for v := range results {
		if original.ID != "" && original.ID != v.ID {
			t.Fatal("one key created multiple originals")
		}
		original = v
	}
	if original.Status != "unknown" || original.LocalSpaceID != binding.LocalSpaceID || original.Result != nil {
		t.Fatal("intent was not durable unknown")
	}
	changed := expected
	changed.Digest = control.Hash("other")
	if _, _, err := store.ReserveRemote(ctx, changed); !errors.Is(err, control.ErrConflict) {
		t.Fatal("different parameters accepted")
	}
	accepted, err := store.SaveRemoteResult(ctx, original, "accepted", json.RawMessage(`{"status":"accepted"}`))
	if err != nil {
		t.Fatal(err)
	}
	confirmed, err := store.SaveRemoteResult(ctx, accepted, "confirmed", json.RawMessage(`{"status":"confirmed","evidence":{"type":"device_result"}}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"accepted", "dispatched", "unknown", "failed"} {
		v, err := store.SaveRemoteResult(ctx, original, status, json.RawMessage(`{"status":"late"}`))
		if err != nil || v.Status != "confirmed" {
			t.Fatal("late response replaced terminal result")
		}
	}
	second := &mysqlstore.Store{DB: store.DB}
	restored, err := second.RemoteCommand(ctx, original.PrincipalID, space.ID, input.Key, true)
	if err != nil || restored.ID != confirmed.ID || restored.Status != "confirmed" {
		t.Fatal("new store instance lost original result")
	}
	base := "/api/console/v1/spaces/" + space.ID
	c.call("POST", base+"/remote-commands", input, 200)
	offline := input
	offline.Key = "offline"
	c.call("POST", base+"/remote-commands", offline, 503)
	c.call("GET", base+"/remote-commands/by-key/offline", nil, 404)
	other := newClient(t, server.URL)
	other.login("admin", cfg.Logins["admin"].LocalToken)
	other.call("GET", base+"/remote-commands/"+original.ID, nil, 401)
	other.call("POST", base+"/remote-commands", input, 401)
	// 当前scope和owner必须在写事务里复核；只读历史仍按当前owner隔离。
	if _, err := store.DB.Exec(`UPDATE control_gateways SET scopes=JSON_ARRAY('devices.read') WHERE revision=?`, binding.Revision); err != nil {
		t.Fatal(err)
	}
	fresh := expected
	fresh.ID = "remote-" + control.Random()
	fresh.Input.Key = "scope"
	fresh.Digest = control.Hash("scope")
	if _, _, err := store.ReserveRemote(ctx, fresh); !errors.Is(err, control.ErrForbidden) {
		t.Fatal("missing commands scope accepted")
	}
	if _, err := store.DB.Exec(`UPDATE control_gateways SET scopes=JSON_ARRAY('commands.write','devices.read') WHERE revision=?`, binding.Revision); err != nil {
		t.Fatal(err)
	}
	// 在本测试的独立空间内构造保留历史，验证配额满后不回收原键或继续新建。
	tx, err := store.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	statement, err := tx.PrepareContext(ctx, `INSERT INTO control_remote_commands (remote_id,space_id,principal_id,gateway_id,binding_revision,local_space_id,request_key,request_digest,request_body,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'unknown',UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))`)
	if err != nil {
		t.Fatal(err)
	}
	defer statement.Close()
	for range 1023 {
		history := input
		history.Key = control.Random()
		raw, err := json.Marshal(history)
		if err != nil {
			t.Fatal(err)
		}
		hash, err := control.CanonicalDigest(history)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := statement.ExecContext(ctx, "remote-"+control.Random(), space.ID, binding.PrincipalID, binding.ID, binding.Revision, binding.LocalSpaceID, history.Key, hash, raw); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.ReserveRemote(ctx, fresh); !errors.Is(err, control.ErrCapacity) {
		t.Fatal("full space accepted another durable remote intent")
	}
	if v, created, err := store.ReserveRemote(ctx, expected); err != nil || created || v.ID != original.ID {
		t.Fatal("quota erased original idempotency key")
	}
	if err := store.RevokeGateway(ctx, binding.PrincipalID, space.ID, binding.ID, binding.Revision); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.ReserveRemote(ctx, fresh); !errors.Is(err, control.ErrMissing) {
		t.Fatal("revoked binding accepted new command")
	}
	c.call("GET", base+"/remote-commands/"+original.ID, nil, 200)
	if _, err := store.DB.Exec(`UPDATE control_memberships SET active=FALSE WHERE space_id=? AND principal_id=?`, space.ID, binding.PrincipalID); err != nil {
		t.Fatal(err)
	}
	c.call("GET", base+"/remote-commands/"+original.ID, nil, 404)
}
