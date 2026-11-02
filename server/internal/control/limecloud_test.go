package control

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func installation(generation float64) map[string]any {
	return map[string]any{"lime_installation_id": "ins_fixture", "lime_space_id": "sp_fixture", "lime_release_id": "rel_fixture", "lime_installation_generation": generation}
}

func TestCloudContextAndCredentialIsolation(t *testing.T) {
	p := NewOIDC(LoginConfig{CloudEnvironment: "production", ApplicationID: "app_fixture"}, "console")
	valid := installation(1)
	if _, err := p.cloudContext(valid); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []func(map[string]any){
		func(v map[string]any) { delete(v, "lime_space_id") },
		func(v map[string]any) { v["lime_installation_generation"] = 1.5 },
		func(v map[string]any) { v["lime_installation_generation"] = float64(0) },
		func(v map[string]any) { v["lime_application_id"] = "app_other" },
		func(v map[string]any) { v["lime_environment"] = "sandbox" },
		func(v map[string]any) { v["lime_authorization_source"] = "sandbox_test_approval" },
		func(v map[string]any) { v["lime_test_space_id"] = "orphan_test_field" },
	} {
		claims := installation(1)
		mutation(claims)
		if _, err := p.cloudContext(claims); err == nil {
			t.Fatal("invalid installation accepted")
		}
	}
	encoded, err := p.encodeCredential("fixture-bearer", valid)
	if err != nil {
		t.Fatal(err)
	}
	if credential, err := p.decodeCredential(encoded); err != nil || credential.Token != "fixture-bearer" {
		t.Fatal("credential did not round-trip")
	}
	for _, config := range []LoginConfig{{CloudEnvironment: "production", ApplicationID: "app_other"}, {CloudEnvironment: "sandbox", ApplicationID: "app_fixture"}, {}} {
		other := NewOIDC(config, "console")
		if _, err := other.decodeCredential(encoded); err == nil {
			t.Fatal("cross-environment/application credential accepted")
		}
	}
	sandbox := NewOIDC(LoginConfig{CloudEnvironment: "sandbox", ApplicationID: "app_fixture"}, "console")
	if _, err := sandbox.cloudContext(map[string]any{}); err != nil {
		t.Fatal("ordinary sandbox identity rejected")
	}
	if _, err := sandbox.cloudContext(valid); err == nil {
		t.Fatal("sandbox accepted production installation")
	}
	if _, err := p.decodeCredential("unbound-bearer"); err == nil {
		t.Fatal("Cloud session accepted an unbound credential")
	}
	p.Config.InstallationID, p.Config.SpaceID = "ins_fixture", "sp_fixture"
	if _, err := p.cloudContext(valid); err != nil {
		t.Fatal("configured installation rejected")
	}
	for _, key := range []string{"lime_installation_id", "lime_space_id"} {
		other := installation(1)
		other[key] = "different_installation_or_space"
		if _, err := p.cloudContext(other); err != ErrIdentity {
			t.Fatal("configured installation selection accepted another signed context")
		}
	}
}

func TestCloudOIDCFlowAndCurrentInstallation(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var generation atomic.Int64
	generation.Store(1)
	var revoked atomic.Bool
	var server *httptest.Server
	claims := func() map[string]any {
		v := installation(float64(generation.Load()))
		v["sub"] = "pairwise-fixture-user"
		v["name"] = "Fixture User"
		return v
	}
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]any{"issuer": server.URL, "authorization_endpoint": server.URL + "/authorize", "token_endpoint": server.URL + "/token", "userinfo_endpoint": server.URL + "/userinfo", "jwks_uri": server.URL + "/jwks", "revocation_endpoint": server.URL + "/revoke", "id_token_signing_alg_values_supported": []string{"RS256"}})
		case "/jwks":
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "fixture", "alg": "RS256", "use": "sig", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": "AQAB"}}})
		case "/token":
			_ = r.ParseForm()
			client, secret, ok := r.BasicAuth()
			if !ok || client != "client_fixture" || secret != "fixture-secret" || r.Form.Get("code_verifier") != "fixture-verifier" || r.Form.Get("redirect_uri") != "https://iot.example/api/console/v1/auth/callback" {
				w.WriteHeader(400)
				return
			}
			v := claims()
			v["iss"], v["aud"], v["nonce"] = server.URL, "client_fixture", "fixture-nonce"
			v["iat"], v["exp"] = time.Now().Unix(), time.Now().Add(time.Hour).Unix()
			header, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "fixture"})
			payload, _ := json.Marshal(v)
			unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
			digest := sha256.Sum256([]byte(unsigned))
			signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
			if err != nil {
				t.Error(err)
				w.WriteHeader(500)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "fixture-bearer", "token_type": "Bearer", "expires_in": 3600, "id_token": unsigned + "." + base64.RawURLEncoding.EncodeToString(signature)})
		case "/userinfo":
			if revoked.Load() || r.Header.Get("Authorization") != "Bearer fixture-bearer" {
				w.WriteHeader(401)
				return
			}
			_ = json.NewEncoder(w).Encode(claims())
		case "/revoke":
			_ = r.ParseForm()
			if r.Form.Get("token") != "fixture-bearer" {
				t.Error("credential envelope leaked to revocation endpoint")
			}
			revoked.Store(true)
			w.WriteHeader(200)
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	p := NewOIDC(LoginConfig{Origin: "https://iot.example", Issuer: server.URL, ClientID: "client_fixture", ClientSecret: "fixture-secret", CloudEnvironment: "production", ApplicationID: "app_fixture"}, "console")
	ctx := context.Background()
	location, err := p.Authorize(ctx, "fixture-state", "fixture-nonce", "fixture-verifier")
	if err != nil {
		t.Fatal(err)
	}
	authorization, _ := url.Parse(location)
	challenge := sha256.Sum256([]byte("fixture-verifier"))
	if authorization.Query().Get("code_challenge") != base64.RawURLEncoding.EncodeToString(challenge[:]) || authorization.Query().Get("code_challenge_method") != "S256" || authorization.Query().Get("scope") != "openid profile email" {
		t.Fatal("PKCE or identity scopes missing")
	}
	if authorization.Query().Has("installation_id") || authorization.Query().Has("space_id") {
		t.Fatal("public login unexpectedly fixed an installation")
	}
	p.Config.InstallationID, p.Config.SpaceID = "ins_fixture", "sp_fixture"
	location, err = p.Authorize(ctx, "fixture-state", "fixture-nonce", "fixture-verifier")
	if err != nil {
		t.Fatal(err)
	}
	authorization, _ = url.Parse(location)
	if authorization.Query().Get("installation_id") != "ins_fixture" || authorization.Query().Get("space_id") != "sp_fixture" || authorization.Query().Get("state") != "fixture-state" || authorization.Query().Get("nonce") != "fixture-nonce" || authorization.Query().Get("code_challenge") != base64.RawURLEncoding.EncodeToString(challenge[:]) {
		t.Fatal("explicit installation changed the original authorization flow")
	}
	id, err := p.Exchange(ctx, "fixture-code", "fixture-verifier", "fixture-nonce")
	if err != nil || id.Subject != "pairwise-fixture-user" || !strings.HasPrefix(id.AccessToken, cloudCredentialPrefix) {
		t.Fatalf("exchange: %v", err)
	}
	if subject, err := p.Current(ctx, id.AccessToken); err != nil || subject != id.Subject {
		t.Fatalf("current identity: %v", err)
	}
	generation.Store(2)
	if _, err := p.Current(ctx, id.AccessToken); err != ErrIdentity {
		t.Fatal("changed installation generation retained the old session")
	}
	generation.Store(1)
	if err := p.Revoke(ctx, id.AccessToken); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Current(ctx, id.AccessToken); err != ErrIdentity {
		t.Fatal("revoked identity retained the session")
	}
}

func TestAuthenticatedEdgeForwardedHost(t *testing.T) {
	edge := Random()
	for _, test := range []struct {
		name, edge, forwarded, host string
		configured                  bool
		status                      int
	}{
		{"trusted edge", edge, "iot.example", "backend.up.railway.app", true, 200},
		{"spoofed edge", "wrong", "iot.example", "backend.up.railway.app", true, 421},
		{"wrong audience", edge, "other.example", "backend.up.railway.app", true, 421},
		{"missing forwarded host", edge, "", "backend.up.railway.app", true, 421},
		{"no edge configured", edge, "iot.example", "backend.up.railway.app", false, 421},
		{"direct private instance", "", "untrusted.example", "iot.example", false, 200},
	} {
		t.Run(test.name, func(t *testing.T) {
			cfg := Config{Mode: "private", Origin: "https://iot.example", Logins: map[string]LoginConfig{"console": {Origin: "https://iot.example"}, "admin": {Origin: "https://iot.example"}}}
			if test.configured {
				cfg.EdgeToken = edge
			}
			s := &Server{cfg: cfg}
			r := httptest.NewRequest("GET", "https://"+test.host+"/api/console/v1/auth/config", nil)
			r.Header.Set("X-LimeIoT-Edge-Token", test.edge)
			r.Header.Set("X-LimeIoT-Forwarded-Host", test.forwarded)
			w := httptest.NewRecorder()
			s.Handler().ServeHTTP(w, r)
			if w.Code != test.status {
				t.Fatalf("got %d, want %d", w.Code, test.status)
			}
		})
	}
}
