package integration

import (
	"encoding/json"
	"os"
	"reflect"
	"regexp"
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
					if ok && (reference == "./model.schema.json" || reference == "./model-validation-report.schema.json" || reference == "./model-compatibility-report.schema.json" || reference == "./model-release.schema.json" || reference == "./model-release-trust.schema.json") {
						raw, err := os.ReadFile("../../contracts/" + strings.TrimPrefix(reference, "./"))
						if err != nil {
							t.Fatal(err)
						}
						var model map[string]any
						if err := json.Unmarshal(raw, &model); err != nil {
							t.Fatal(err)
						}
						if model["$schema"] != "https://json-schema.org/draft/2020-12/schema" || model["type"] != "object" {
							t.Fatal("invalid model contract reference")
						}
						continue
					}
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
	checkControlTools(t, document)
	cfg := control.Config{Origin: "http://127.0.0.1:17890", Mode: "private", Key: make([]byte, 32), Logins: map[string]control.LoginConfig{"console": {Origin: "http://127.0.0.1:17890", LocalToken: control.Random()}, "admin": {Origin: "http://127.0.0.1:17890", LocalToken: control.Random()}}}
	store := &mysqlstore.Store{}
	app, err := control.New(cfg, control.Dependencies{Sessions: store, Registry: store, Machines: store, Remote: store, Native: store, Products: store, Readiness: store})
	if err != nil {
		t.Fatal(err)
	}
	routes := map[string]bool{}
	for _, route := range app.Handler().(*gin.Engine).Routes() {
		// 静态构建入口由专门的路径/Host/CSP/目录逃逸检查覆盖，不属于JSON API。
		if route.Method == "GET" && (route.Path == "/console/*asset" || route.Path == "/admin/*asset") {
			continue
		}
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
				for _, variable := range []string{"space", "pairing", "gateway", "revision", "remote", "key", "authorization", "product", "release"} {
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

// CLI目录可以选择实现子集，但路径、方法和输入限制必须与正式HTTP合同相同。
func checkControlTools(t *testing.T, document map[string]any) {
	t.Helper()
	raw, err := os.ReadFile("../../contracts/tools/control.json")
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Operations []struct {
			ID     string `json:"operation_id"`
			Method string `json:"method"`
			Path   string `json:"path"`
			Input  string `json:"input_schema"`
		} `json:"operations"`
		Schemas map[string]any `json:"schemas"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		t.Fatal(err)
	}
	placeholder := regexp.MustCompile(`\{[^}]+\}`)
	var normalize func(any) any
	normalize = func(value any) any {
		switch v := value.(type) {
		case map[string]any:
			if ref, ok := v["$ref"].(string); ok {
				var target any = document
				for _, key := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
					target = target.(map[string]any)[key]
				}
				return normalize(target)
			}
			out := map[string]any{}
			for key, item := range v {
				if key != "description" {
					out[key] = normalize(item)
				}
			}
			return out
		case []any:
			out := make([]any, len(v))
			for i, item := range v {
				out[i] = normalize(item)
			}
			return out
		default:
			return value
		}
	}
	seen := map[string]bool{}
	for _, op := range catalog.Operations {
		if seen[op.ID] {
			t.Fatal("duplicate control tool")
		}
		seen[op.ID] = true
		found := false
		for route, item := range document["paths"].(map[string]any) {
			if placeholder.ReplaceAllString(route, "{}") != placeholder.ReplaceAllString(op.Path, "{}") {
				continue
			}
			method, ok := item.(map[string]any)[strings.ToLower(op.Method)].(map[string]any)
			if !ok {
				continue
			}
			found = true
			if op.Input != "" {
				body := method["requestBody"].(map[string]any)["content"].(map[string]any)["application/json"].(map[string]any)["schema"]
				if !reflect.DeepEqual(normalize(body), normalize(catalog.Schemas[op.Input])) {
					t.Fatalf("control tool input diverges: %s", op.ID)
				}
			}
		}
		if !found {
			t.Fatalf("control tool route missing: %s", op.ID)
		}
	}
}
