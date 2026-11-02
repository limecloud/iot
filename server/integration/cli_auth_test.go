package integration

import (
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/limecloud/iot/server/internal/control"
	"github.com/limecloud/iot/server/internal/mysqlstore"
)

func testCLISessions(t *testing.T, store *mysqlstore.Store) {
	for _, mode := range []string{"private", "cloud"} {
		t.Run(mode, func(t *testing.T) {
			p := newProvider(t)
			cfg := control.Config{Mode: mode, Key: make([]byte, 32), Logins: map[string]control.LoginConfig{"console": {LocalToken: control.Random()}, "admin": {LocalToken: control.Random()}}}
			if mode == "cloud" {
				cfg.Logins = map[string]control.LoginConfig{"console": {Issuer: p.issuer(), ClientID: "console-client", ClientSecret: p.clients["console-client"]}, "admin": {Issuer: p.issuer(), ClientID: "admin-client", ClientSecret: p.clients["admin-client"], Operators: map[string]bool{"operator": true}}}
			}
			server, cfg := newApp(t, store, cfg)
			owner := newClient(t, server.URL)
			if mode == "cloud" {
				owner.oidc(p, "console", "cli-owner", "", 303)
				owner.session("console")
			} else {
				owner.login("console", cfg.Logins["console"].LocalToken)
			}
			owner.request("POST", "/api/console/v1/auth/cli", map[string]string{}, 403, server.URL, false)
			owner.request("POST", "/api/console/v1/auth/cli", map[string]string{}, 403, "https://other.invalid", true)
			type material struct {
				Token   string    `json:"session"`
				ID      string    `json:"principal_id"`
				Expires time.Time `json:"expires_at"`
			}
			mint := func() (*client, material) {
				v := decode[material](t, owner.call("POST", "/api/console/v1/auth/cli", map[string]string{}, 200))
				if len(v.Token) != 64 || time.Until(v.Expires) <= 0 || time.Until(v.Expires) > time.Hour {
					t.Fatal("invalid CLI lifetime or material")
				}
				child := newClient(t, server.URL)
				u, _ := url.Parse(server.URL)
				child.http.Jar.SetCookies(u, []*http.Cookie{{Name: "limeiot_console", Value: v.Token, Path: "/"}})
				if child.session("console").ID != v.ID {
					t.Fatal("CLI principal changed")
				}
				return child, v
			}
			child, _ := mint()
			child.call("GET", "/api/admin/v1/status", nil, 401)
			child.call("POST", "/api/console/v1/auth/cli", map[string]string{}, 403)
			child.call("POST", "/api/console/v1/auth/logout", map[string]string{}, 200)
			owner.session("console")
			second, _ := mint()
			if mode == "cloud" {
				p.status.Store(503)
				second.call("GET", "/api/console/v1/auth/session", nil, 503)
				p.status.Store(0)
				second.session("console")
				p.mismatch.Store(true)
				second.call("GET", "/api/console/v1/auth/session", nil, 401)
				p.mismatch.Store(false)
				second, _ = mint()
			}
			owner.call("POST", "/api/console/v1/auth/logout", map[string]string{}, 200)
			second.call("GET", "/api/console/v1/auth/session", nil, 401)
		})
	}
}
