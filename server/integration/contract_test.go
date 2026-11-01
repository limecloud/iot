package integration

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/goccy/go-yaml"
	"github.com/limecloud/iot/server/internal/control"
	"github.com/limecloud/iot/server/internal/mysqlstore"
)

func TestControlContractRoutesAndReferences(t *testing.T) {
	raw, err := os.ReadFile("../../contracts/control.openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err = yaml.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	// 转为标准 JSON 值，确保合同中没有无法机器读取的 YAML 特殊类型。
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(encoded, &document); err != nil {
		t.Fatal(err)
	}
	var walk func(any)
	walk = func(value any) {
		switch v := value.(type) {
		case map[string]any:
			for k, item := range v {
				if k == "$ref" {
					reference, ok := item.(string)
					if !ok || !strings.HasPrefix(reference, "#/") {
						t.Fatal("unexpected external reference")
					}
					var target any = document
					for _, part := range strings.Split(strings.TrimPrefix(reference, "#/"), "/") {
						part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
						mapping, ok := target.(map[string]any)
						if !ok {
							t.Fatalf("invalid reference %s", reference)
						}
						target, ok = mapping[part]
						if !ok {
							t.Fatalf("missing reference %s", reference)
						}
					}
				}
				walk(item)
			}
		case []any:
			for _, item := range v {
				walk(item)
			}
		}
	}
	walk(document)
	cfg := control.Config{Origin: "http://127.0.0.1:17890", Mode: "private", Key: make([]byte, 32), Logins: map[string]control.LoginConfig{"console": {Origin: "http://127.0.0.1:17890", LocalToken: control.Random()}, "admin": {Origin: "http://127.0.0.1:17890", LocalToken: control.Random()}}}
	store := &mysqlstore.Store{}
	app, err := control.New(cfg, store, store, store, store, nil)
	if err != nil {
		t.Fatal(err)
	}
	routes := map[string]bool{}
	for _, route := range app.Handler().(*gin.Engine).Routes() {
		routes[route.Method+" "+route.Path] = true
	}
	ids := map[string]bool{}
	for path, item := range document["paths"].(map[string]any) {
		for method, value := range item.(map[string]any) {
			if method == "parameters" {
				continue
			}
			if method != "get" && method != "post" {
				t.Fatalf("unexpected method %s", method)
			}
			id, ok := value.(map[string]any)["operationId"].(string)
			if !ok || ids[id] {
				t.Fatalf("missing or duplicate operation id %s", id)
			}
			ids[id] = true
			for _, audience := range []string{"console", "admin"} {
				expanded := strings.ReplaceAll(path, "{audience}", audience)
				for _, variable := range []string{"space", "pairing", "gateway"} {
					expanded = strings.ReplaceAll(expanded, "{"+variable+"}", ":"+variable)
				}
				key := strings.ToUpper(method) + " " + expanded
				if !routes[key] {
					t.Fatalf("contract route is not implemented: %s", key)
				}
				delete(routes, key)
				if !strings.Contains(path, "{audience}") {
					break
				}
			}
		}
	}
	if len(routes) != 0 {
		t.Fatalf("undocumented routes: %v", routes)
	}
}
