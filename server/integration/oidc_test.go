package integration

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/limecloud/iot/server/internal/control"
	"github.com/limecloud/iot/server/internal/mysqlstore"
)

type grant struct{ subject, nonce, challenge, client, redirect, mode string }
type provider struct {
	server      *httptest.Server
	key         ed25519.PrivateKey
	mu          sync.Mutex
	codes       map[string]grant
	tokens      map[string]string
	clients     map[string]string
	status      atomic.Int32
	mismatch    atomic.Bool
	revocations atomic.Int32
}

func newProvider(t *testing.T) *provider {
	t.Helper()
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	p := &provider{key: key, codes: map[string]grant{}, tokens: map[string]string{}, clients: map[string]string{"console-client": control.Random(), "admin-client": control.Random()}}
	mux := http.NewServeMux()
	p.server = httptest.NewServer(mux)
	t.Cleanup(p.server.Close)
	mux.HandleFunc("/oidc/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"issuer": p.issuer(), "authorization_endpoint": p.server.URL + "/authorize", "token_endpoint": p.server.URL + "/token", "userinfo_endpoint": p.server.URL + "/userinfo", "jwks_uri": p.server.URL + "/jwks", "revocation_endpoint": p.server.URL + "/revoke", "id_token_signing_alg_values_supported": []string{"EdDSA"}})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]string{"kty": "OKP", "crv": "Ed25519", "use": "sig", "alg": "EdDSA", "kid": "fixture", "x": base64.RawURLEncoding.EncodeToString(key.Public().(ed25519.PublicKey))}}})
	})
	mux.HandleFunc("/token", p.token)
	mux.HandleFunc("/userinfo", func(w http.ResponseWriter, r *http.Request) {
		if status := p.status.Load(); status != 0 {
			w.WriteHeader(int(status))
			return
		}
		p.mu.Lock()
		subject, ok := p.tokens[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
		p.mu.Unlock()
		if !ok {
			w.WriteHeader(401)
			return
		}
		if p.mismatch.Load() {
			subject = "other-subject"
		}
		json.NewEncoder(w).Encode(map[string]string{"sub": subject})
	})
	mux.HandleFunc("/revoke", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		p.mu.Lock()
		delete(p.tokens, r.Form.Get("token"))
		p.mu.Unlock()
		p.revocations.Add(1)
		w.WriteHeader(200)
	})
	return p
}
func (p *provider) issuer() string { return p.server.URL + "/oidc" }
func (p *provider) issue(t *testing.T, location, subject, mode string) (string, string) {
	t.Helper()
	u, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if u.Scheme+"://"+u.Host+u.Path != p.server.URL+"/authorize" || q.Get("code_challenge_method") != "S256" || q.Get("scope") != "openid profile" || q.Get("response_type") != "code" {
		t.Fatal("invalid code+PKCE authorization request")
	}
	code := control.Random()
	p.mu.Lock()
	p.codes[code] = grant{subject: subject, nonce: q.Get("nonce"), challenge: q.Get("code_challenge"), client: q.Get("client_id"), redirect: q.Get("redirect_uri"), mode: mode}
	p.mu.Unlock()
	return code, q.Get("state")
}
func (p *provider) token(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	client, secret, _ := r.BasicAuth()
	p.mu.Lock()
	g, ok := p.codes[r.Form.Get("code")]
	delete(p.codes, r.Form.Get("code"))
	p.mu.Unlock()
	hash := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
	if !ok || client != g.client || secret != p.clients[client] || base64.RawURLEncoding.EncodeToString(hash[:]) != g.challenge || r.Form.Get("redirect_uri") != g.redirect || r.Form.Get("grant_type") != "authorization_code" {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": "invalid_grant"})
		return
	}
	now := time.Now()
	claims := map[string]any{"iss": p.issuer(), "aud": g.client, "sub": g.subject, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix(), "nonce": g.nonce, "name": "测试开发者"}
	switch g.mode {
	case "nonce":
		claims["nonce"] = "wrong"
	case "audience":
		claims["aud"] = "different-client"
	case "issuer":
		claims["iss"] = "https://wrong.invalid"
	case "azp":
		claims["aud"] = []string{g.client, "other-client"}
		claims["azp"] = "other-client"
	case "expired":
		claims["exp"] = now.Add(-time.Hour).Unix()
	}
	head, _ := json.Marshal(map[string]string{"alg": "EdDSA", "kid": "fixture"})
	body, _ := json.Marshal(claims)
	unsigned := base64.RawURLEncoding.EncodeToString(head) + "." + base64.RawURLEncoding.EncodeToString(body)
	key := p.key
	if g.mode == "signature" {
		_, key, _ = ed25519.GenerateKey(rand.Reader)
	}
	signed := unsigned + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(unsigned)))
	access := control.Random()
	p.mu.Lock()
	p.tokens[access] = g.subject
	p.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"access_token": access, "token_type": "Bearer", "expires_in": 3600, "id_token": signed})
}
func (c *client) beginOIDC(a string) string {
	c.t.Helper()
	return decode[struct {
		Location string `json:"authorize_url"`
	}](c.t, c.call("POST", "/api/"+a+"/v1/auth/start", map[string]string{}, 200)).Location
}
func (c *client) oidc(p *provider, a, subject, mode string, status int) {
	c.t.Helper()
	location := c.beginOIDC(a)
	code, state := p.issue(c.t, location, subject, mode)
	c.call("GET", "/api/"+a+"/v1/auth/callback?state="+url.QueryEscape(state)+"&code="+url.QueryEscape(code), nil, status)
}
func testOIDC(t *testing.T, store *mysqlstore.Store) {
	p := newProvider(t)
	key := make([]byte, 32)
	rand.Read(key)
	server, _ := newApp(t, store, control.Config{Mode: "cloud", Key: key, Logins: map[string]control.LoginConfig{"console": {Issuer: p.issuer(), ClientID: "console-client", ClientSecret: p.clients["console-client"]}, "admin": {Issuer: p.issuer(), ClientID: "admin-client", ClientSecret: p.clients["admin-client"], Operators: map[string]bool{"operator": true}}}})
	a := newClient(t, server.URL)
	b := newClient(t, server.URL)
	operator := newClient(t, server.URL)
	location := a.beginOIDC("console")
	code, state := p.issue(t, location, "developer-a", "")
	a.call("GET", "/api/console/v1/auth/callback?state="+control.Random()+"&code="+code, nil, 401)
	base, _ := url.Parse(server.URL)
	flows := a.http.Jar.Cookies(base)
	a.call("GET", "/api/console/v1/auth/callback?state="+state+"&code="+code, nil, 303)
	owner := a.session("console")
	replay := newClient(t, server.URL)
	replay.http.Jar.SetCookies(base, flows)
	replay.call("GET", "/api/console/v1/auth/callback?state="+state+"&code="+code, nil, 401)
	b.oidc(p, "console", "developer-b", "", 303)
	b.session("console")
	operator.oidc(p, "admin", "operator", "", 303)
	operator.session("admin")
	operator.call("GET", "/api/console/v1/spaces", nil, 401)
	space := decode[control.Space](t, a.call("POST", "/api/console/v1/spaces", map[string]string{"request_key": "cloud-home", "name": "云家庭"}, 200))
	b.call("GET", "/api/console/v1/spaces/"+space.ID+"/gateways", nil, 404)
	b.call("POST", "/api/console/v1/spaces/"+space.ID+"/pairings", map[string]any{"request_key": "steal", "scopes": []string{"devices.read"}}, 404)
	list := b.call("GET", "/api/console/v1/spaces", nil, 200)
	if strings.Contains(string(list), space.ID) {
		t.Fatal("another user saw the space")
	}
	unauthorized := newClient(t, server.URL)
	before := p.revocations.Load()
	unauthorized.oidc(p, "admin", "developer-a", "", 403)
	unauthorized.call("GET", "/api/admin/v1/auth/session", nil, 401)
	if p.revocations.Load() != before+1 {
		t.Fatal("denied operator token not revoked")
	}
	for _, mode := range []string{"nonce", "audience", "issuer", "azp", "signature", "expired"} {
		t.Run(mode, func(t *testing.T) {
			bad := newClient(t, server.URL)
			before := p.revocations.Load()
			bad.oidc(p, "console", "developer-invalid", mode, 401)
			bad.call("GET", "/api/console/v1/auth/session", nil, 401)
			if p.revocations.Load() != before+1 {
				t.Fatal("rejected token not revoked")
			}
		})
	}
	p.status.Store(503)
	a.call("GET", "/api/console/v1/auth/session", nil, 503)
	p.status.Store(0)
	if got := a.session("console"); got.ID != owner.ID {
		t.Fatal("provider outage changed identity")
	}
	// 提供方故障时仍允许用户结束本站会话。
	p.status.Store(503)
	b.call("POST", "/api/console/v1/auth/logout", map[string]string{}, 200)
	b.call("GET", "/api/console/v1/auth/session", nil, 401)
	p.status.Store(0)
	p.mismatch.Store(true)
	a.call("GET", "/api/console/v1/auth/session", nil, 401)
	p.mismatch.Store(false)
	a.call("GET", "/api/console/v1/auth/session", nil, 401)
}
