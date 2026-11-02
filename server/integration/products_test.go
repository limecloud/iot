package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"sync"
	"testing"

	"github.com/limecloud/iot/server/internal/control"
	"github.com/limecloud/iot/server/internal/mysqlstore"
)

func testProductDrafts(t *testing.T, store *mysqlstore.Store) {
	p := newProvider(t)
	cfg := control.Config{Mode: "cloud", Key: make([]byte, 32), Logins: map[string]control.LoginConfig{
		"console": {Issuer: p.issuer(), ClientID: "console-client", ClientSecret: p.clients["console-client"]},
		"admin":   {Issuer: p.issuer(), ClientID: "admin-client", ClientSecret: p.clients["admin-client"], Operators: map[string]bool{"operator": true}},
	}}
	server, cfg := newApp(t, store, cfg)
	c := newClient(t, server.URL)
	c.oidc(p, "console", "product-owner", "", 303)
	actor := c.session("console")
	const base = "/api/console/v1/products"
	input := control.ProductWrite{Key: "create", Name: "环境灯", Model: json.RawMessage(`{"z":1.0,"a":true}`)}
	c.request("POST", base, input, 403, "https://other.invalid", true)
	c.request("POST", base, input, 403, server.URL, false)
	anon := newClient(t, server.URL)
	anon.call("GET", base, nil, 401)
	created := decode[control.ProductOperation](t, c.call("POST", base, input, 200))
	if created.Status != "saved" || created.Product.Status != "draft" || created.Product.Validation != "unvalidated" || created.PrincipalID != actor.ID || created.Product.Revision == "" {
		t.Fatal("draft incorrectly represented as published or unowned")
	}
	// 相同JSON键序和数值表示不创建新决定；重查返回当时快照。
	input.Model = json.RawMessage(`{"a":true,"z":1}`)
	retried := decode[control.ProductOperation](t, c.call("POST", base, input, 200))
	a, _ := control.CanonicalDigest(created)
	b, _ := control.CanonicalDigest(retried)
	if a != b {
		t.Fatal("same key changed immutable operation")
	}
	changed := input
	changed.Name = "其他产品"
	c.call("POST", base, changed, 409)
	resource := base + "/" + created.ProductID
	input.ExpectedRevision = created.Product.Revision
	c.call("POST", resource+"/drafts", input, 409) // 原键不能跨kind复用。
	input.Key = "save"
	input.Name = "环境灯 v2"
	saved := decode[control.ProductOperation](t, c.call("POST", resource+"/drafts", input, 200))
	if saved.Status != "saved" || saved.Product.Revision == created.Product.Revision || saved.Product.DocumentDigest != created.Product.DocumentDigest {
		t.Fatal("aggregate revision confused with model digest")
	}
	input.Key = "stale"
	conflict := decode[control.ProductOperation](t, c.call("POST", resource+"/drafts", input, 200))
	if conflict.Status != "conflict" || conflict.Product.Revision != saved.Product.Revision {
		t.Fatal("stale write overwrote current draft")
	}
	// 两个并发编辑者使用相同基线，只有一个保存；败者的决定不可后来变为成功。
	var wg sync.WaitGroup
	results := make(chan control.ProductOperation, 2)
	for i := range 2 {
		wg.Go(func() {
			v := input
			v.Key = fmt.Sprintf("race-%d", i)
			v.ExpectedRevision = saved.Product.Revision
			v.Name = fmt.Sprintf("并发编辑 %d", i)
			results <- decode[control.ProductOperation](t, c.call("POST", resource+"/drafts", v, 200))
		})
	}
	wg.Wait()
	close(results)
	counts := map[string]int{}
	for v := range results {
		counts[v.Status]++
	}
	if counts["saved"] != 1 || counts["conflict"] != 1 {
		t.Fatal("concurrent writers escaped revision check")
	}
	current := decode[control.Product](t, c.call("GET", resource, nil, 200))
	old := decode[control.ProductOperation](t, c.call("GET", "/api/console/v1/product-operations/by-key/create", nil, 200))
	if old.Product.Revision != created.Product.Revision || current.Revision == old.Product.Revision {
		t.Fatal("historical operation is mutable")
	}
	input.ExpectedRevision = created.Product.Revision
	input.Key = "stale"
	retryConflict := decode[control.ProductOperation](t, c.call("POST", resource+"/drafts", input, 200))
	if retryConflict.ID != conflict.ID || retryConflict.Product.Revision != conflict.Product.Revision || retryConflict.Status != "conflict" {
		t.Fatal("conflict decision changed")
	}
	// 新应用实例直接查询同一会话/原键，不依赖旧进程内存。
	app, err := control.New(cfg, control.Dependencies{Sessions: store, Registry: store, Machines: store, Remote: store, Native: store, Products: store, Readiness: store})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	r := httptest.NewRequest("GET", server.URL+"/api/console/v1/product-operations/by-key/create", nil)
	u, _ := url.Parse(server.URL)
	for _, cookie := range c.http.Jar.Cookies(u) {
		r.AddCookie(cookie)
	}
	rr := httptest.NewRecorder()
	app.Handler().ServeHTTP(rr, r)
	if rr.Code != 200 || decode[control.ProductOperation](t, rr.Body.Bytes()).ID != created.ID {
		t.Fatal("new application lost original")
	}
	other := newClient(t, server.URL)
	other.oidc(p, "console", "product-other", "", 303)
	other.session("console")
	other.call("GET", resource, nil, 404)
	other.call("GET", "/api/console/v1/product-operations/by-key/create", nil, 404)
	other.call("POST", resource+"/drafts", control.ProductWrite{Key: "other", Name: "越权", ExpectedRevision: current.Revision, Model: json.RawMessage(`{}`)}, 404)
	if len(decode[control.ProductPage](t, other.call("GET", base, nil, 200)).Items) != 0 {
		t.Fatal("cross publisher list leak")
	}
	admin := newClient(t, server.URL)
	admin.oidc(p, "admin", "operator", "", 303)
	admin.session("admin")
	admin.call("GET", base, nil, http.StatusUnauthorized)
	admin.call("POST", base, control.ProductWrite{Key: "admin", Name: "越权", Model: json.RawMessage(`{}`)}, 401)
	p.status.Store(503)
	c.call("GET", resource, nil, 503)
	p.status.Store(0)
	c.call("GET", resource, nil, 200)
	for _, bad := range []map[string]any{
		{"request_key": "invalid", "name": "草稿", "model": map[string]any{}, "expected_revision": ""},
		{"request_key": "invalid", "name": "草稿", "model": map[string]any{}, "unknown": true},
		{"request_key": "invalid", "name": " 草稿", "model": map[string]any{}},
		{"request_key": "invalid", "name": "草稿", "model": []any{}},
	} {
		c.call("POST", base, bad, 400)
	}
	c.call("POST", base, control.ProductWrite{Key: "duplicate", Name: "重复", Model: json.RawMessage(`{"x":1,"x":2}`)}, 400)
	c.call("POST", base, json.RawMessage(`{"request_key":"top-duplicate","name":"a","name":"b","model":{}}`), 400)
	c.call("POST", resource+"/drafts", control.ProductWrite{Key: "no-revision", Name: "未提供修订", Model: json.RawMessage(`{}`)}, 400)
	// 分页严格递增，无重复；产品满额后仍可恢复原决定。
	for i := range 127 {
		c.call("POST", base, control.ProductWrite{Key: fmt.Sprintf("page-%d", i), Name: "分页草稿", Model: json.RawMessage(`{}`)}, 200)
	}
	ids := []string{}
	after := ""
	for {
		page := decode[control.ProductPage](t, c.call("GET", base+"?after="+after, nil, 200))
		if len(page.Items) > 16 {
			t.Fatal("unbounded product list")
		}
		for _, v := range page.Items {
			if len(ids) > 0 && v.ID <= ids[len(ids)-1] {
				t.Fatal("duplicate or unordered product")
			}
			ids = append(ids, v.ID)
		}
		if page.Next == nil {
			break
		}
		after = *page.Next
	}
	if len(ids) != 128 {
		t.Fatal("pagination lost products")
	}
	c.call("POST", base, control.ProductWrite{Key: "full", Name: "满额", Model: json.RawMessage(`{}`)}, 429)
	input = created.Input
	c.call("POST", base, input, 200)
	// 只在测试自建库补齐本主体的历史配额；不回收原键。
	for i := 0; i < 900; i++ {
		var count int
		if err := store.DB.QueryRow(`SELECT COUNT(*) FROM control_product_operations WHERE principal_id=?`, actor.ID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count >= 1024 {
			break
		}
		v := saved.Input
		v.Key = fmt.Sprintf("history-%d", i)
		c.call("POST", resource+"/drafts", v, 200)
	}
	input = saved.Input
	input.Key = "op-capacity"
	c.call("POST", resource+"/drafts", input, 429)
	if !reflect.DeepEqual(decode[control.ProductOperation](t, c.call("GET", "/api/console/v1/product-operations/by-key/create", nil, 200)).Product.Revision, created.Product.Revision) {
		t.Fatal("capacity erased history")
	}
	if err := mysqlstore.Check(context.Background(), store.DB); err != nil {
		t.Fatal(err)
	}
}
