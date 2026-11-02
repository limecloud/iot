package integration

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/limecloud/iot/server/internal/control"
	"github.com/limecloud/iot/server/internal/mysqlstore"
)

func TestMachineConnectionVector(t *testing.T) {
	raw, err := os.ReadFile("../../contracts/examples/control-connection-proof.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Seed      string                      `json:"test_seed_hex"`
		Challenge control.ConnectionChallenge `json:"challenge"`
		Binding   control.Gateway             `json:"binding"`
		Proof     string                      `json:"proof"`
		Signature string                      `json:"signature"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	proof := control.ConnectionProof(v.Challenge, v.Binding)
	seed, err := hex.DecodeString(v.Seed)
	if err != nil || len(seed) != ed25519.SeedSize {
		t.Fatal("invalid test seed")
	}
	key := ed25519.NewKeyFromSeed(seed)
	if proof != v.Proof || base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte(proof))) != v.Signature {
		t.Fatal("Node/Go connection vector differs")
	}
}

func testMachineConnections(t *testing.T, store *mysqlstore.Store) {
	server := httptest.NewUnstartedServer(nil)
	origin := "https://" + server.Listener.Addr().String()
	cfg := control.Config{Mode: "private", Origin: origin, Key: make([]byte, 32), Logins: map[string]control.LoginConfig{"console": {Origin: origin, LocalToken: control.Random()}, "admin": {Origin: origin, LocalToken: control.Random()}}}
	app, err := control.New(cfg, control.Dependencies{Sessions: store, Registry: store, Machines: store, Remote: store, Native: store, Products: store, Readiness: store})
	if err != nil {
		t.Fatal(err)
	}
	server.Config.Handler = app.Handler()
	server.StartTLS()
	t.Cleanup(server.Close)
	t.Cleanup(app.Close)
	owner := newClient(t, origin)
	owner.http.Transport = server.Client().Transport
	owner.login("console", cfg.Logins["console"].LocalToken)
	space := decode[control.Space](t, owner.call("POST", "/api/console/v1/spaces", map[string]string{"request_key": control.Random(), "name": "机器连接测试"}, 200))
	pair := owner.pair(space.ID, "connect")
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	claim := sign(origin, pair.Pairing, key, "local-test")
	claim.Code = pair.Code
	binding := decode[control.Gateway](t, owner.call("POST", "/api/pairing/v1/"+pair.Pairing.ID+"/claim", claim, 200))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	write := func(conn *websocket.Conn, value any) {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil || conn.Write(ctx, websocket.MessageText, raw) != nil {
			t.Fatal("machine frame write failed")
		}
	}
	read := func(conn *websocket.Conn, value any) {
		t.Helper()
		kind, raw, err := conn.Read(ctx)
		if err != nil || kind != websocket.MessageText || json.Unmarshal(raw, value) != nil {
			t.Fatalf("machine frame read failed: %v", err)
		}
	}
	dial := func() (*websocket.Conn, control.ConnectionChallenge) {
		t.Helper()
		conn, _, err := websocket.Dial(ctx, origin+"/api/gateway/v1/connect", &websocket.DialOptions{HTTPClient: server.Client(), Subprotocols: []string{"limeiot.relay.v1"}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.CloseNow() })
		var challenge control.ConnectionChallenge
		read(conn, &challenge)
		if conn.Subprotocol() != "limeiot.relay.v1" || challenge.Type != "challenge" || challenge.Origin != origin || time.Until(challenge.Expires) <= 0 || time.Until(challenge.Expires) > 15*time.Second {
			t.Fatal("invalid machine challenge")
		}
		return conn, challenge
	}
	authenticate := func(ch control.ConnectionChallenge) control.MachineAuthentication {
		return control.MachineAuthentication{Type: "authenticate", GatewayID: binding.ID, SpaceID: binding.SpaceID, LocalSpaceID: binding.LocalSpaceID, PrincipalID: binding.PrincipalID, Revision: binding.Revision, Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte(control.ConnectionProof(ch, binding))))}
	}
	closed := func(conn *websocket.Conn) {
		t.Helper()
		readCtx, done := context.WithTimeout(ctx, 2*time.Second)
		defer done()
		if _, _, err := conn.Read(readCtx); err == nil {
			t.Fatal("unauthorized machine remained connected")
		}
	}
	path := "/api/console/v1/spaces/" + space.ID + "/gateways/" + binding.ID + "/connection"
	if decode[control.ConnectionView](t, owner.call("GET", path, nil, 200)).Connected {
		t.Fatal("unconnected binding reported online")
	}
	for _, test := range []struct {
		name   string
		mutate func(*control.ConnectionChallenge, *control.MachineAuthentication)
	}{
		{"wrong_origin", func(ch *control.ConnectionChallenge, auth *control.MachineAuthentication) {
			ch.Origin = "https://other.example"
			*auth = authenticate(*ch)
		}},
		{"wrong_space", func(_ *control.ConnectionChallenge, auth *control.MachineAuthentication) {
			auth.SpaceID = "other-space"
		}},
		{"wrong_local_space", func(_ *control.ConnectionChallenge, auth *control.MachineAuthentication) {
			auth.LocalSpaceID = "other-local"
		}},
		{"wrong_principal", func(_ *control.ConnectionChallenge, auth *control.MachineAuthentication) {
			auth.PrincipalID = "other-owner"
		}},
		{"wrong_revision", func(_ *control.ConnectionChallenge, auth *control.MachineAuthentication) {
			auth.Revision = "other-revision"
		}},
		{"wrong_key", func(ch *control.ConnectionChallenge, auth *control.MachineAuthentication) {
			_, other, _ := ed25519.GenerateKey(rand.Reader)
			auth.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(other, []byte(control.ConnectionProof(*ch, binding))))
		}},
	} {
		t.Logf("machine rejection: %s", test.name)
		conn, ch := dial()
		auth := authenticate(ch)
		test.mutate(&ch, &auth)
		write(conn, auth)
		closed(conn)
	}
	for _, header := range []http.Header{{"Origin": {origin}}, {"Cookie": {"limeiot_console=example"}}, {"Authorization": {"Bearer example"}}} {
		conn, response, err := websocket.Dial(ctx, origin+"/api/gateway/v1/connect", &websocket.DialOptions{HTTPClient: server.Client(), HTTPHeader: header, Subprotocols: []string{"limeiot.relay.v1"}})
		if conn != nil {
			_ = conn.CloseNow()
		}
		if err == nil || response == nil || response.StatusCode != 403 {
			t.Fatal("browser identity accepted as machine")
		}
	}
	conn, firstChallenge := dial()
	firstAuth := authenticate(firstChallenge)
	write(conn, firstAuth)
	var rawReady map[string]any
	read(conn, &rawReady)
	if rawReady["type"] != "ready" || rawReady["binding_revision"] != binding.Revision {
		t.Fatal("machine not ready")
	}
	duplicate, ch := dial()
	write(duplicate, authenticate(ch))
	var rejected map[string]any
	read(duplicate, &rejected)
	if rejected["code"] != "machine_already_connected" {
		t.Fatal("duplicate replaced active connection")
	}
	closed(duplicate)
	replay, _ := dial()
	write(replay, firstAuth)
	closed(replay)
	write(conn, map[string]any{"type": "heartbeat", "connection_id": firstChallenge.ConnectionID, "sequence": 1})
	var heartbeat map[string]any
	read(conn, &heartbeat)
	if heartbeat["sequence"] != float64(1) {
		t.Fatal("heartbeat not acknowledged")
	}
	view := decode[control.ConnectionView](t, owner.call("GET", path, nil, 200))
	if !view.Connected || view.Revision != binding.Revision || view.ConnectedAt == nil || view.LastSeen == nil {
		t.Fatal("connection status unavailable")
	}
	admin := newClient(t, origin)
	admin.http.Transport = server.Client().Transport
	admin.login("admin", cfg.Logins["admin"].LocalToken)
	admin.call("GET", path, nil, 401)
	owner.call("POST", "/api/console/v1/spaces/"+space.ID+"/gateways/"+binding.ID+"/revoke", map[string]string{"revision": binding.Revision}, 200)
	closed(conn)
	old, challenge := dial()
	write(old, authenticate(challenge))
	closed(old)
	owner.call("GET", path, nil, 404)
	// 当前绑定被撤销后，旧证明不能在新连接中恢复。
	if _, err := store.MachineBinding(ctx, binding.ID, binding.Revision); err == nil {
		t.Fatal("revoked machine returned")
	}
}
