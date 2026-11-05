package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/limecloud/iot/server/internal/control"
	"github.com/limecloud/iot/server/internal/mysqlstore"
)

func testNativeAuthorization(t *testing.T, store *mysqlstore.Store) {
	for _, mode := range []string{"private", "cloud"} {
		t.Run(mode, func(t *testing.T) {
			provider := newProvider(t)
			cfg := control.Config{Mode: mode, Key: make([]byte, 32), Logins: map[string]control.LoginConfig{"console": {LocalToken: control.Random()}, "admin": {LocalToken: control.Random()}}}
			if mode == "cloud" {
				cfg.Logins = map[string]control.LoginConfig{"console": {Issuer: provider.issuer(), ClientID: "console-client", ClientSecret: provider.clients["console-client"]}, "admin": {Issuer: provider.issuer(), ClientID: "admin-client", ClientSecret: provider.clients["admin-client"], Operators: map[string]bool{"operator": true}}}
			}
			server, cfg := newApp(t, store, cfg)
			owner := newClient(t, server.URL)
			call := func(route string, value any, status int) []byte {
				t.Helper()
				raw, _ := json.Marshal(value)
				response, err := http.Post(server.URL+route, "application/json", bytes.NewReader(raw))
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				body, _ := io.ReadAll(response.Body)
				if response.StatusCode != status {
					t.Fatalf("native %s expected %d got %d: %s", route, status, response.StatusCode, body)
				}
				if response.Header.Get("Cache-Control") != "no-store" {
					t.Fatal("native response cacheable")
				}
				return body
			}
			type started struct {
				ID      string    `json:"authorization_id"`
				Code    string    `json:"user_code"`
				URL     string    `json:"verification_uri"`
				Expires time.Time `json:"expires_at"`
				Status  string    `json:"status"`
			}
			type polled struct {
				Status   string                  `json:"status"`
				Material control.SessionMaterial `json:"material"`
			}
			start := func(platforms ...string) (started, map[string]string, map[string]string) {
				t.Helper()
				platform := "ios"
				if len(platforms) > 0 {
					platform = platforms[0]
				}
				key, verifier := control.Random(), control.Random()
				digest := sha256.Sum256([]byte(verifier))
				input := map[string]string{"request_key": key, "code_challenge": base64.RawURLEncoding.EncodeToString(digest[:]), "platform": platform}
				v := decode[started](t, call("/api/native/v1/authorizations", input, 200))
				if time.Until(v.Expires) > 5*time.Minute || v.Status != "pending" || len(v.Code) != 8 || !strings.HasSuffix(v.URL, "/console/?native="+v.ID) {
					t.Fatal("invalid native initiation")
				}
				return v, input, map[string]string{"request_key": key, "code_verifier": verifier}
			}
			v, input, proof := start()
			operator := newClient(t, server.URL)
			var other *client
			if mode == "private" {
				owner.login("console", cfg.Logins["console"].LocalToken)
				operator.login("admin", cfg.Logins["admin"].LocalToken)
			} else {
				owner.call("POST", "/api/admin/v1/auth/start", map[string]string{"native_authorization": v.ID}, 400)
				owner.call("POST", "/api/console/v1/auth/start", map[string]string{"native_authorization": "https://other.invalid"}, 400)
				owner.call("POST", "/api/console/v1/auth/start", map[string]string{"native_authorization": "na-" + control.Random()}, 404)
				owner.call("POST", "/api/console/v1/auth/start", map[string]string{"native_authorization": v.ID, "redirect_uri": "https://other.invalid"}, 400)
				location := decode[struct {
					Location string `json:"authorize_url"`
				}](t, owner.call("POST", "/api/console/v1/auth/start", map[string]string{"native_authorization": v.ID}, 200)).Location
				code, state := provider.issue(t, location, "native-owner", "")
				response, err := owner.http.Get(server.URL + "/api/console/v1/auth/callback?state=" + state + "&code=" + code + "&native_authorization=na-" + control.Random() + "&redirect_uri=https://other.invalid")
				if err != nil {
					t.Fatal(err)
				}
				response.Body.Close()
				if response.StatusCode != 303 || response.Header.Get("Location") != "/console/?native="+v.ID {
					t.Fatal("OIDC native return was not bound to the original flow")
				}
				owner.session("console")
				operator.oidc(provider, "admin", "operator", "", 303)
				operator.session("admin")
				other = newClient(t, server.URL)
				other.oidc(provider, "console", "native-other", "", 303)
				other.session("console")
			}
			for _, platform := range []string{"macos", "windows"} {
				desktop, original, desktopProof := start(platform)
				desktopPath := "/api/console/v1/native-authorizations/" + desktop.ID
				review := decode[struct {
					Platform string `json:"platform"`
				}](t, owner.call("GET", desktopPath, nil, 200))
				if review.Platform != platform {
					t.Fatal("desktop platform changed")
				}
				changed := map[string]string{"request_key": original["request_key"], "code_challenge": original["code_challenge"], "platform": "ios"}
				call("/api/native/v1/authorizations", changed, 409)
				owner.call("POST", desktopPath, map[string]string{"decision": "approve", "user_code": desktop.Code}, 200)
				material := decode[polled](t, call("/api/native/v1/authorizations/poll", desktopProof, 200))
				if material.Status != "approved" || material.Material.Token == "" {
					t.Fatal("desktop did not receive independent approved session")
				}
				call("/api/native/v1/authorizations/cancel", desktopProof, 200)
				if cancelled := decode[polled](t, call("/api/native/v1/authorizations/poll", desktopProof, 200)); cancelled.Status != "cancelled" || cancelled.Material.Token != "" {
					t.Fatal("desktop cancellation restored identity")
				}
			}
			if old := decode[started](t, call("/api/native/v1/authorizations", input, 200)); old.ID != v.ID || old.Code != v.Code || !old.Expires.Equal(v.Expires) {
				t.Fatal("native initiation replay changed original")
			}
			changed := map[string]string{"request_key": input["request_key"], "code_challenge": input["code_challenge"], "platform": "android"}
			call("/api/native/v1/authorizations", changed, 409)
			owner.call("POST", "/api/native/v1/authorizations", input, 403)
			if p := decode[polled](t, call("/api/native/v1/authorizations/poll", proof, 200)); p.Status != "pending" || p.Material.Token != "" {
				t.Fatal("pending exported identity")
			}
			wrongProof := map[string]string{"request_key": proof["request_key"], "code_verifier": control.Random()}
			call("/api/native/v1/authorizations/poll", wrongProof, 401)
			path := "/api/console/v1/native-authorizations/" + v.ID
			operator.call("GET", path, nil, 401)
			operator.call("POST", path, map[string]string{"decision": "approve", "user_code": v.Code}, 401)
			review := owner.call("GET", path, nil, 200)
			for _, secret := range []string{v.Code, proof["request_key"], proof["code_verifier"], input["code_challenge"]} {
				if strings.Contains(string(review), secret) {
					t.Fatal("browser review leaked native material")
				}
			}
			owner.request("POST", path, map[string]string{"decision": "approve", "user_code": v.Code}, 403, server.URL, false)
			owner.request("POST", path, map[string]string{"decision": "approve", "user_code": v.Code}, 403, "https://other.invalid", true)
			var wg sync.WaitGroup
			for range 4 {
				wg.Go(func() { owner.call("POST", path, map[string]string{"decision": "approve", "user_code": v.Code}, 200) })
			}
			wg.Wait()
			if other != nil {
				other.call("POST", path, map[string]string{"decision": "approve", "user_code": v.Code}, 409)
			}
			first := decode[polled](t, call("/api/native/v1/authorizations/poll", proof, 200))
			second := decode[polled](t, call("/api/native/v1/authorizations/poll", proof, 200))
			if first.Status != "approved" || first.Material.Token == "" || first.Material.Token != second.Material.Token || time.Until(first.Material.Expires) > time.Hour {
				t.Fatal("approval did not return a single durable child")
			}
			auth, err := store.NativeAuthorization(context.Background(), v.ID, false)
			if err != nil || auth.ChildHash != control.Hash(first.Material.Token) {
				t.Fatal("native child missing")
			}
			child := newClient(t, server.URL)
			u, _ := url.Parse(server.URL)
			child.http.Jar.SetCookies(u, []*http.Cookie{{Name: "limeiot_console", Value: first.Material.Token, Path: "/"}})
			child.session("console")
			space := decode[control.Space](t, owner.call("POST", "/api/console/v1/spaces", map[string]string{"request_key": control.Random(), "name": "原生授权范围"}, 200))
			child.call("GET", "/api/console/v1/spaces/"+space.ID+"/gateways", nil, 200)
			if other != nil {
				other.call("GET", "/api/console/v1/spaces/"+space.ID+"/gateways", nil, 404)
			}
			child.call("GET", "/api/admin/v1/status", nil, 401)
			child.call("POST", path, map[string]string{"decision": "approve", "user_code": v.Code}, 403)
			if mode == "cloud" {
				provider.status.Store(503)
				call("/api/native/v1/authorizations/poll", proof, 503)
				provider.status.Store(0)
				call("/api/native/v1/authorizations/poll", proof, 200)
			}
			call("/api/native/v1/authorizations/cancel", proof, 200)
			call("/api/native/v1/authorizations/cancel", proof, 200)
			child.call("GET", "/api/console/v1/auth/session", nil, 401)
			if p := decode[polled](t, call("/api/native/v1/authorizations/poll", proof, 200)); p.Status != "cancelled" || p.Material.Token != "" {
				t.Fatal("cancel restored material")
			}
			owner.call("POST", path, map[string]string{"decision": "approve", "user_code": v.Code}, 409)
			denied, _, deniedProof := start()
			denyPath := "/api/console/v1/native-authorizations/" + denied.ID
			owner.call("POST", denyPath, map[string]string{"decision": "deny", "user_code": denied.Code}, 200)
			owner.call("POST", denyPath, map[string]string{"decision": "approve", "user_code": denied.Code}, 409)
			if p := decode[polled](t, call("/api/native/v1/authorizations/poll", deniedProof, 200)); p.Status != "denied" || p.Material.Token != "" {
				t.Fatal("denied request became granted")
			}
			locked, _, lockedProof := start()
			for range 5 {
				owner.call("POST", "/api/console/v1/native-authorizations/"+locked.ID, map[string]string{"decision": "approve", "user_code": "INVALID!"}, 403)
			}
			if p := decode[polled](t, call("/api/native/v1/authorizations/poll", lockedProof, 200)); p.Status != "denied" {
				t.Fatal("code guessing not bounded")
			}
			expired, expiredInput, expiredProof := start()
			if _, err := store.DB.Exec(`UPDATE control_native_authorizations SET expires_at=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 SECOND) WHERE authorization_id=?`, expired.ID); err != nil {
				t.Fatal(err)
			}
			call("/api/native/v1/authorizations", expiredInput, 410)
			call("/api/native/v1/authorizations/poll", expiredProof, 410)
			owner.call("POST", "/api/console/v1/native-authorizations/"+expired.ID, map[string]string{"decision": "approve", "user_code": expired.Code}, 410)
			if mode == "cloud" {
				owner.call("POST", "/api/console/v1/auth/start", map[string]string{"native_authorization": expired.ID}, 410)
			}
			// 批准与取消争抢同一行锁，最终不能遗留可用的子会话。
			racing, _, racingProof := start()
			approval := make(chan *http.Response, 1)
			approvalError := make(chan error, 1)
			go func() {
				raw, _ := json.Marshal(map[string]string{"decision": "approve", "user_code": racing.Code})
				req, _ := http.NewRequest("POST", server.URL+"/api/console/v1/native-authorizations/"+racing.ID, bytes.NewReader(raw))
				req.Header.Set("Origin", server.URL)
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("X-CSRF-Token", owner.csrf["console"])
				response, err := owner.http.Do(req)
				if err != nil {
					approvalError <- err
					return
				}
				approval <- response
			}()
			call("/api/native/v1/authorizations/cancel", racingProof, 200)
			select {
			case err := <-approvalError:
				t.Fatal(err)
			case response := <-approval:
				response.Body.Close()
				if response.StatusCode != 200 && response.StatusCode != 409 {
					t.Fatalf("approval/cancel race returned %d", response.StatusCode)
				}
			}
			if p := decode[polled](t, call("/api/native/v1/authorizations/poll", racingProof, 200)); p.Status != "cancelled" || p.Material.Token != "" {
				t.Fatal("cancel race exported a session")
			}
			raced, err := store.NativeAuthorization(context.Background(), racing.ID, false)
			if err != nil {
				t.Fatal(err)
			}
			if raced.ChildHash != "" {
				if _, err := store.Session(context.Background(), raced.ChildHash, "console"); err == nil {
					t.Fatal("cancel race left an active child")
				}
			}
			last, _, lastProof := start()
			owner.call("POST", "/api/console/v1/native-authorizations/"+last.ID, map[string]string{"decision": "approve", "user_code": last.Code}, 200)
			owner.call("POST", "/api/console/v1/auth/logout", map[string]string{}, 200)
			call("/api/native/v1/authorizations/poll", lastProof, 401)
		})
	}
}
