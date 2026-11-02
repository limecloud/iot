package integration

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/limecloud/iot/server/internal/control"
	"github.com/limecloud/iot/server/internal/mysqlstore"
)

func TestWebBuildBoundaries(t *testing.T) {
	directory := t.TempDir()
	console := filepath.Join(directory, "console")
	admin := filepath.Join(directory, "admin")
	for name, root := range map[string]string{"console": console, "admin": admin} {
		if err := os.MkdirAll(filepath.Join(root, "assets"), 0700); err != nil {
			t.Fatal(err)
		}
		for file, body := range map[string]string{"index.html": "<h1>" + name + "</h1>", "assets/app.js": "export {};"} {
			if err := os.WriteFile(filepath.Join(root, file), []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	secret := filepath.Join(directory, "secret")
	if err := os.WriteFile(secret, []byte("outside-secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(console, "assets", "escape.js")); err != nil {
		t.Fatal(err)
	}
	cfg := control.Config{Mode: "private", Origin: "https://control.example", Key: make([]byte, 32), EdgeToken: control.Random(), WebDirs: map[string]string{"console": console, "admin": admin}, Logins: map[string]control.LoginConfig{"console": {Origin: "https://console.example", LocalToken: control.Random()}, "admin": {Origin: "https://admin.example", LocalToken: control.Random()}}}
	store := &mysqlstore.Store{}
	app, err := control.New(cfg, control.Dependencies{Sessions: store, Registry: store, Machines: store, Remote: store, Native: store, Products: store, Readiness: store})
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	handler := app.Handler()
	perform := func(url, edge string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", url, nil)
		req.Header.Set("X-LimeIoT-Edge-Token", edge)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	for _, audience := range []string{"console", "admin"} {
		url := "https://" + audience + ".example/" + audience + "/"
		w := perform(url, cfg.EdgeToken)
		if w.Code != 200 || w.Body.String() != "<h1>"+audience+"</h1>" || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
			t.Fatal("static shell crossed audience or CSP/cache boundary")
		}
		asset := perform(url+"assets/app.js", cfg.EdgeToken)
		if asset.Code != 200 || !strings.Contains(asset.Header().Get("Cache-Control"), "immutable") {
			t.Fatal("compiled asset unavailable")
		}
		if perform(url, "").Code != 403 {
			t.Fatal("static shell bypassed edge credential")
		}
	}
	if perform("https://control.example/console/", cfg.EdgeToken).Code != 421 {
		t.Fatal("static shell accepted another audience Host")
	}
	for _, path := range []string{"assets/escape.js", "assets/", "src/main.tsx", ".env", "../secret", "assets/../../secret"} {
		w := perform("https://console.example/console/"+path, cfg.EdgeToken)
		if w.Code == 200 || strings.Contains(w.Body.String(), "outside-secret") {
			t.Fatalf("static build escaped allowed files: %s", path)
		}
	}
}
