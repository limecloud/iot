package integration

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/limecloud/iot/server/internal/control"
	"github.com/limecloud/iot/server/internal/mysqlstore"
)

type client struct {
	t    *testing.T
	base string
	http *http.Client
	csrf map[string]string
}

func newClient(t *testing.T, base string) *client {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	return &client{t: t, base: base, http: &http.Client{Jar: jar, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, csrf: map[string]string{}}
}
func (c *client) call(method, path string, payload any, status int) []byte {
	c.t.Helper()
	return c.request(method, path, payload, status, c.base, true)
}
func (c *client) request(method, path string, payload any, status int, origin string, csrf bool) []byte {
	c.t.Helper()
	var reader io.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			c.t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, c.base+path, reader)
	if err != nil {
		c.t.Fatal(err)
	}
	if method != "GET" {
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		if csrf {
			for a, token := range c.csrf {
				if strings.HasPrefix(path, "/api/"+a+"/") {
					req.Header.Set("X-CSRF-Token", token)
				}
			}
		}
	}
	response, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		c.t.Fatal(err)
	}
	if response.StatusCode != status {
		c.t.Fatalf("%s %s: expected %d, got %d: %s", method, strings.Split(path, "?")[0], status, response.StatusCode, raw)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		c.t.Fatal("response may be cached")
	}
	for _, cookie := range response.Cookies() {
		if cookie.Path != "/" || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
			c.t.Fatal("unsafe session cookie")
		}
	}
	return raw
}
func decode[T any](t *testing.T, raw []byte) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}
func (c *client) session(a string) control.Principal {
	c.t.Helper()
	v := decode[struct {
		Principal control.Principal `json:"principal"`
		CSRF      string            `json:"csrf_token"`
	}](c.t, c.call("GET", "/api/"+a+"/v1/auth/session", nil, 200))
	if len(v.CSRF) != 64 {
		c.t.Fatal("missing CSRF token")
	}
	c.csrf[a] = v.CSRF
	return v.Principal
}
func (c *client) login(a, token string) control.Principal {
	c.t.Helper()
	c.call("POST", "/api/"+a+"/v1/auth/local", map[string]string{"token": token}, 200)
	return c.session(a)
}

type pairResponse struct {
	Pairing control.Pairing `json:"pairing"`
	Code    string          `json:"code"`
	Origin  string          `json:"control_origin"`
}

func (c *client) pair(space, key string) pairResponse {
	c.t.Helper()
	return decode[pairResponse](c.t, c.call("POST", "/api/console/v1/spaces/"+space+"/pairings", map[string]any{"request_key": key, "scopes": []string{"devices.read", "commands.write"}}, 200))
}
func sign(origin string, p control.Pairing, key ed25519.PrivateKey, local string) control.Claim {
	public := key.Public().(ed25519.PublicKey)
	v := control.Claim{GatewayID: "gw-" + control.Hash(string(public)), LocalSpaceID: local, PublicKey: base64.StdEncoding.EncodeToString(public)}
	v.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte(control.PairingProof(origin, p, v))))
	return v
}
func newApp(t *testing.T, store *mysqlstore.Store, cfg control.Config) (*httptest.Server, control.Config) {
	t.Helper()
	server := httptest.NewUnstartedServer(nil)
	cfg.Origin = "http://" + server.Listener.Addr().String()
	for a, l := range cfg.Logins {
		l.Origin = cfg.Origin
		cfg.Logins[a] = l
	}
	app, err := control.New(cfg, control.Dependencies{Sessions: store, Registry: store, Machines: store, Remote: store, Native: store, Products: store, Publications: store, Readiness: store})
	if err != nil {
		t.Fatal(err)
	}
	server.Config.Handler = app.Handler()
	server.Start()
	t.Cleanup(server.Close)
	t.Cleanup(app.Close)
	return server, cfg
}
func TestControlWithMySQL(t *testing.T) {
	if os.Getenv("LIMEIOT_CONTROL_TEST_ISOLATED") != "1" {
		t.Skip("use node tools/test-control.mjs with its isolated MySQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	var store *mysqlstore.Store
	deadline := time.Now().Add(50 * time.Second)
	for {
		db, err := mysqlstore.Connect(ctx)
		if err == nil {
			store = &mysqlstore.Store{DB: db}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("isolated mysql did not become ready")
		}
		time.Sleep(250 * time.Millisecond)
	}
	defer store.DB.Close()
	if mysqlstore.Check(ctx, store.DB) == nil {
		t.Fatal("unmigrated schema accepted")
	}
	// 先建立真实v1基线，再验证显式升级，不用全新建库替代升级路径。
	v1, err := os.ReadFile("../internal/mysqlstore/schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range strings.Split(string(v1), ";") {
		if strings.TrimSpace(statement) != "" {
			if _, err := store.DB.ExecContext(ctx, statement); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := store.DB.ExecContext(ctx, `CREATE TABLE control_schema_migrations (version INT PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at DATETIME(6) NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DB.ExecContext(ctx, `INSERT INTO control_schema_migrations VALUES (1,?,UTC_TIMESTAMP(6))`, control.Hash(string(v1))); err != nil {
		t.Fatal(err)
	}
	if mysqlstore.Check(ctx, store.DB) == nil {
		t.Fatal("v1 treated as current schema ready")
	}
	if err := mysqlstore.Migrate(ctx, store.DB); err != nil {
		t.Fatal(err)
	}
	if err := mysqlstore.Migrate(ctx, store.DB); err != nil {
		t.Fatal(err)
	}
	if err := mysqlstore.Check(ctx, store.DB); err != nil {
		t.Fatal(err)
	}
	var versionCount int
	if err := store.DB.QueryRow(`SELECT COUNT(*) FROM control_schema_migrations`).Scan(&versionCount); err != nil || versionCount != 5 {
		t.Fatal("v1 upgrade did not preserve ordered history")
	}
	t.Run("private_sessions_pairing_and_revocation", func(t *testing.T) { testPrivate(t, store) })
	t.Run("oidc_and_space_isolation", func(t *testing.T) { testOIDC(t, store) })
	t.Run("cli_session_parent_and_audience", func(t *testing.T) { testCLISessions(t, store) })
	t.Run("product_drafts", func(t *testing.T) { testProductDrafts(t, store) })
	t.Run("model_publications", func(t *testing.T) { testModelPublications(t, store) })
	t.Run("native_authorization_and_recovery", func(t *testing.T) { testNativeAuthorization(t, store) })
	t.Run("machine_connection_and_revocation", func(t *testing.T) { testMachineConnections(t, store) })
	t.Run("remote_durability_and_authorization", func(t *testing.T) { testRemoteDurability(t, store) })
	t.Run("edge_and_https_cookie_boundaries", func(t *testing.T) {
		origin := "https://iot.example"
		cfg := control.Config{Mode: "private", Origin: origin, Key: make([]byte, 32), EdgeToken: control.Random(), Logins: map[string]control.LoginConfig{"console": {Origin: origin, LocalToken: control.Random()}, "admin": {Origin: origin, LocalToken: control.Random()}}}
		app, err := control.New(cfg, control.Dependencies{Sessions: store, Registry: store, Machines: store, Remote: store, Native: store, Products: store, Readiness: store})
		if err != nil {
			t.Fatal(err)
		}
		handler := app.Handler()
		perform := func(method, path, payload, edge string) *httptest.ResponseRecorder {
			req := httptest.NewRequest(method, origin+path, strings.NewReader(payload))
			req.Header.Set("Origin", origin)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-LimeIoT-Edge-Token", edge)
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)
			return rr
		}
		if perform("GET", "/api/console/v1/auth/config", "", "").Code != 403 {
			t.Fatal("edge credential omitted")
		}
		if perform("GET", "/health/ready", "", "").Code != 200 {
			t.Fatal("exact health probe unavailable")
		}
		if perform("GET", "/health/ready/extra", "", "").Code != 403 {
			t.Fatal("health prefix bypassed edge check")
		}
		payload := `{"token":"` + cfg.Logins["console"].LocalToken + `"}`
		response := perform("POST", "/api/console/v1/auth/local", payload, cfg.EdgeToken)
		if response.Code != 200 {
			t.Fatal("HTTPS local login failed")
		}
		cookies := response.Result().Cookies()
		if len(cookies) != 1 || cookies[0].Name != "__Host-limeiot_console" || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].Path != "/" || cookies[0].Domain != "" {
			t.Fatal("HTTPS cookie boundary missing")
		}
		for range 30 {
			perform("POST", "/api/admin/v1/auth/local", `{"token":"wrong"}`, cfg.EdgeToken)
		}
		if perform("POST", "/api/admin/v1/auth/local", `{"token":"wrong"}`, cfg.EdgeToken).Code != 429 {
			t.Fatal("login attempts not bounded")
		}
	})
	t.Run("concurrent_original_requests", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		owner, err := store.Principal(ctx, control.Identity{Issuer: "test-concurrency", Subject: "owner"})
		if err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		ids := make(chan string, 8)
		errs := make(chan error, 8)
		for range 8 {
			wg.Go(func() {
				v, err := store.CreateSpace(ctx, owner.ID, "same-key", "并发空间", control.Hash("并发空间"))
				ids <- v.ID
				errs <- err
			})
		}
		wg.Wait()
		close(ids)
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatal(err)
			}
		}
		id := ""
		for v := range ids {
			if id != "" && v != id {
				t.Fatal("duplicate space")
			}
			id = v
		}
		flow := control.Flow{Hash: control.Hash("flow"), StateHash: control.Hash("state"), Audience: "console", Nonce: control.Random(), Verifier: []byte("encrypted-fixture"), Expires: time.Now().Add(time.Minute)}
		if err = store.SaveFlow(ctx, flow); err != nil {
			t.Fatal(err)
		}
		successes := make(chan bool, 8)
		for range 8 {
			wg.Go(func() {
				_, err := store.TakeFlow(ctx, flow.Hash, flow.StateHash, flow.Audience)
				successes <- err == nil
			})
		}
		wg.Wait()
		close(successes)
		count := 0
		for ok := range successes {
			if ok {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("flow consumed %d times", count)
		}
	})
	t.Run("concurrent_claims_have_one_active_binding", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		claims := make([]control.Pairing, 2)
		gateway := control.Claim{GatewayID: "gw-" + control.Hash("same-public-key"), LocalSpaceID: "same-local", PublicKey: "validated-by-http-layer"}
		for i := range 2 {
			owner, err := store.Principal(ctx, control.Identity{Issuer: "test-claim-race", Subject: control.Random()})
			if err != nil {
				t.Fatal(err)
			}
			space, err := store.CreateSpace(ctx, owner.ID, "create", "竞争空间", control.Hash("竞争空间"))
			if err != nil {
				t.Fatal(err)
			}
			pairing := control.Pairing{ID: "pair-" + control.Random(), SpaceID: space.ID, Principal: owner, Challenge: control.Random(), Scopes: []string{"devices.read"}, Expires: time.Now().Add(time.Minute), Code: []byte("encrypted-fixture"), CodeHash: control.Hash(control.Random()), RequestKey: "pair", Digest: control.Hash("devices.read")}
			claims[i], err = store.SavePairing(ctx, pairing)
			if err != nil {
				t.Fatal(err)
			}
		}
		var wg sync.WaitGroup
		errs := make(chan error, 2)
		for _, pairing := range claims {
			wg.Go(func() { _, err := store.Claim(ctx, pairing, gateway); errs <- err })
		}
		wg.Wait()
		close(errs)
		won, lost := 0, 0
		for err := range errs {
			if err == nil {
				won++
			} else if errors.Is(err, control.ErrAlreadyBound) {
				lost++
			} else {
				t.Fatal(err)
			}
		}
		if won != 1 || lost != 1 {
			t.Fatalf("active binding race: successes=%d conflicts=%d", won, lost)
		}
	})
}
func testPrivate(t *testing.T, store *mysqlstore.Store) {
	consoleToken, adminToken := control.Random(), control.Random()
	key := make([]byte, 32)
	rand.Read(key)
	server, cfg := newApp(t, store, control.Config{Mode: "private", Key: key, Logins: map[string]control.LoginConfig{"console": {LocalToken: consoleToken}, "admin": {LocalToken: adminToken}}})
	c := newClient(t, server.URL)
	c.request("POST", "/api/console/v1/auth/local", map[string]string{"token": consoleToken}, 403, "https://untrusted.invalid", false)
	c.call("POST", "/api/console/v1/auth/local", map[string]string{"token": "wrong"}, 401)
	owner := c.login("console", consoleToken)
	admin := newClient(t, server.URL)
	operator := admin.login("admin", adminToken)
	if owner.ID == operator.ID {
		t.Fatal("admin is a family member")
	}
	u, _ := url.Parse(server.URL)
	cookies := c.http.Jar.Cookies(u)
	if len(cookies) != 1 {
		t.Fatal("missing session")
	}
	oldCookie := cookies[0]
	forged := newClient(t, server.URL)
	forged.http.Jar.SetCookies(u, []*http.Cookie{{Name: "limeiot_admin", Value: oldCookie.Value, Path: "/"}})
	forged.call("GET", "/api/admin/v1/auth/session", nil, 401)
	admin.call("GET", "/api/console/v1/spaces", nil, 401)
	input := map[string]string{"request_key": "first-space", "name": "我的家庭"}
	c.request("POST", "/api/console/v1/spaces", input, 403, c.base, false)
	space := decode[control.Space](t, c.call("POST", "/api/console/v1/spaces", input, 200))
	same := decode[control.Space](t, c.call("POST", "/api/console/v1/spaces", input, 200))
	if space.ID != same.ID {
		t.Fatal("idempotency lost")
	}
	c.call("POST", "/api/console/v1/spaces", map[string]string{"request_key": "first-space", "name": "不同内容"}, 409)
	p := c.pair(space.ID, "pair-first")
	again := c.pair(space.ID, "pair-first")
	if p.Code != again.Code || p.Pairing.ID != again.Pairing.ID {
		t.Fatal("pairing recovery changed the original")
	}
	path := "/api/pairing/v1/" + p.Pairing.ID
	c.call("POST", path+"/review", map[string]string{"code": "wrong"}, 401)
	review := decode[pairResponse](t, c.call("POST", path+"/review", map[string]string{"code": p.Code}, 200))
	if review.Pairing.Principal.ID != owner.ID {
		t.Fatal("wrong review owner")
	}
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	claim := sign(p.Origin, p.Pairing, private, "space-local")
	claim.Code = p.Code
	c.call("POST", path+"/status", claim, 404)
	bad := claim
	bad.LocalSpaceID = "other-local"
	c.call("POST", path+"/claim", bad, 401)
	binding := decode[control.Gateway](t, c.call("POST", path+"/claim", claim, 200))
	repeat := decode[control.Gateway](t, c.call("POST", path+"/claim", claim, 200))
	if binding.Revision != repeat.Revision {
		t.Fatal("claim replay duplicated binding")
	}
	queried := decode[control.Gateway](t, c.call("POST", path+"/status", claim, 200))
	if queried.Revision != binding.Revision {
		t.Fatal("status changed original binding")
	}
	alternate := sign(p.Origin, p.Pairing, private, "different-local")
	alternate.Code = p.Code
	c.call("POST", path+"/claim", alternate, 409)
	revoke := "/api/console/v1/spaces/" + space.ID + "/gateways/" + binding.ID + "/revoke"
	c.call("POST", revoke, map[string]string{"revision": "rev-wrong"}, 404)
	c.call("POST", revoke, map[string]string{"revision": binding.Revision}, 200)
	c.call("POST", revoke, map[string]string{"revision": binding.Revision}, 200)
	c.call("POST", path+"/claim", claim, 409)
	if revoked := decode[control.Gateway](t, c.call("POST", path+"/status", claim, 200)); revoked.Active {
		t.Fatal("revoked binding status is active")
	}
	next := c.pair(space.ID, "pair-again")
	newClaim := sign(next.Origin, next.Pairing, private, "space-local")
	newClaim.Code = next.Code
	nextBinding := decode[control.Gateway](t, c.call("POST", "/api/pairing/v1/"+next.Pairing.ID+"/claim", newClaim, 200))
	if nextBinding.Revision == binding.Revision {
		t.Fatal("rebind did not create a new revision")
	}
	history := decode[struct {
		Gateways []control.Gateway `json:"gateways"`
	}](t, c.call("GET", "/api/console/v1/spaces/"+space.ID+"/gateways", nil, 200))
	if len(history.Gateways) != 2 {
		t.Fatal("lost revoked history")
	}
	summary := admin.call("GET", "/api/admin/v1/gateways", nil, 200)
	for _, secret := range []string{"local_space_id", "principal_id", "public_key", "scopes", "我的家庭", owner.Subject} {
		if bytes.Contains(summary, []byte(secret)) {
			t.Fatalf("admin summary exposed %q", secret)
		}
	}
	// 新建应用实例复用耐久会话，不依赖旧实例的内存缓存。
	second, err := control.New(cfg, control.Dependencies{Sessions: store, Registry: store, Machines: store, Remote: store, Native: store, Products: store, Readiness: store})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", server.URL+"/api/console/v1/auth/session", nil)
	for _, cookie := range c.http.Jar.Cookies(u) {
		req.AddCookie(cookie)
	}
	recorder := httptest.NewRecorder()
	second.Handler().ServeHTTP(recorder, req)
	if recorder.Code != 200 {
		t.Fatal("durable session not restored")
	}
	wrongHost := httptest.NewRequest("GET", "http://untrusted.invalid/api/console/v1/auth/config", nil)
	badHost := httptest.NewRecorder()
	second.Handler().ServeHTTP(badHost, wrongHost)
	if badHost.Code != 421 {
		t.Fatal("untrusted Host accepted")
	}
	more := decode[control.Space](t, c.call("POST", "/api/console/v1/spaces", map[string]string{"request_key": "pairing-boundaries", "name": "边界家庭"}, 200))
	cancelled := c.pair(more.ID, "cancelled")
	latest := c.pair(more.ID, "latest")
	c.call("POST", "/api/pairing/v1/"+cancelled.Pairing.ID+"/review", map[string]string{"code": cancelled.Code}, 410)
	original := c.pair(more.ID, "cancelled")
	if !original.Pairing.Cancelled || original.Pairing.ID != cancelled.Pairing.ID {
		t.Fatal("cancelled pairing silently reopened")
	}
	if _, err := store.DB.Exec(`UPDATE control_pairings SET expires_at=UTC_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE pairing_id=?`, latest.Pairing.ID); err != nil {
		t.Fatal(err)
	}
	c.call("POST", "/api/pairing/v1/"+latest.Pairing.ID+"/review", map[string]string{"code": latest.Code}, 410)
	c.call("POST", "/api/console/v1/spaces/"+more.ID+"/pairings", map[string]any{"request_key": "invalid-scope", "scopes": []string{"*"}}, 400)
	c.login("console", consoleToken)
	stale := newClient(t, server.URL)
	stale.http.Jar.SetCookies(u, []*http.Cookie{oldCookie})
	stale.call("GET", "/api/console/v1/auth/session", nil, 401)
	c.call("POST", "/api/console/v1/auth/logout", map[string]string{}, 200)
	c.call("GET", "/api/console/v1/auth/session", nil, 401)
	if _, err := store.DB.Exec(`UPDATE control_schema_migrations SET checksum=? WHERE version=1`, strings.Repeat("0", 64)); err != nil {
		t.Fatal(err)
	}
	if mysqlstore.Check(context.Background(), store.DB) == nil {
		t.Fatal("schema mismatch accepted")
	}
	c.call("GET", "/health/live", nil, 200)
	c.call("GET", "/health/ready", nil, 503)
	// 仅还原本测试创建的迁移元数据；不触碰用户数据库。
	if _, err := store.DB.Exec(`DELETE FROM control_schema_migrations WHERE version=1`); err != nil {
		t.Fatal(err)
	}
	if mysqlstore.Migrate(context.Background(), store.DB) == nil {
		t.Fatal("migration history gap accepted")
	}
	v1, err := os.ReadFile("../internal/mysqlstore/schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.DB.Exec(`INSERT INTO control_schema_migrations (version,checksum,applied_at) VALUES (1,?,UTC_TIMESTAMP(6))`, control.Hash(string(v1))); err != nil {
		t.Fatal(err)
	}
	if err := mysqlstore.Migrate(context.Background(), store.DB); err != nil {
		t.Fatal(err)
	}
	c.call("GET", "/health/ready", nil, 200)
	if _, err := store.DB.Exec(`INSERT INTO control_schema_migrations (version,checksum,applied_at) VALUES (6,?,UTC_TIMESTAMP(6))`, strings.Repeat("0", 64)); err != nil {
		t.Fatal(err)
	}
	c.call("GET", "/health/ready", nil, 503)
	if mysqlstore.Migrate(context.Background(), store.DB) == nil {
		t.Fatal("unknown future schema accepted")
	}
	if _, err := store.DB.Exec(`DELETE FROM control_schema_migrations WHERE version=6`); err != nil {
		t.Fatal(err)
	}
}
