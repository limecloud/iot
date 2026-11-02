package integration

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/limecloud/iot/server/internal/control"
	"github.com/limecloud/iot/server/internal/mysqlstore"
)

func testModelPublications(t *testing.T, store *mysqlstore.Store) {
	validatorPath := os.Getenv("LIMEIOT_MODEL_VALIDATOR")
	if validatorPath == "" {
		t.Skip("run node tools/test-control.mjs --models with its Rust companion")
	}
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyFile := filepath.Join(t.TempDir(), "model-release-key.pem")
	if err = os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0600); err != nil {
		t.Fatal(err)
	}
	p := newProvider(t)
	server, cfg := newApp(t, store, control.Config{Mode: "cloud", Key: make([]byte, 32), ModelValidatorPath: validatorPath, ModelReleaseKeyFile: keyFile, Logins: map[string]control.LoginConfig{
		"console": {Issuer: p.issuer(), ClientID: "console-client", ClientSecret: p.clients["console-client"]},
		"admin":   {Issuer: p.issuer(), ClientID: "admin-client", ClientSecret: p.clients["admin-client"], Operators: map[string]bool{"operator": true}},
	}})
	c := newClient(t, server.URL)
	c.oidc(p, "console", "model-release-owner", "", 303)
	actor := c.session("console")
	identity := decode[struct {
		Issuer, PublisherID, Namespace string
		Trust                          control.ModelReleaseTrust `json:"trust"`
	}](t, c.call("GET", "/api/console/v1/publisher", nil, 200))
	publisher, err := control.ModelPublisherFor(server.URL, actor.ID)
	if err != nil || identity.Trust.PublisherID != publisher.ID || identity.Trust.Namespace != publisher.Namespace {
		t.Fatal("publisher did not bind current principal and issuer")
	}
	fixture, err := os.ReadFile("../../contracts/examples/model-release.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Model map[string]any `json:"source_model"`
	}
	if json.Unmarshal(fixture, &f) != nil {
		t.Fatal("invalid source model fixture")
	}
	f.Model["model_id"] = "urn:" + publisher.Namespace + ":model:lamp:1"
	model := func(version string) json.RawMessage {
		f.Model["model_version"] = version
		raw, err := json.Marshal(f.Model)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	create := func(key string, raw json.RawMessage) control.Product {
		return decode[control.ProductOperation](t, c.call("POST", "/api/console/v1/products", control.ProductWrite{Key: key, Name: "发布测试灯", Model: raw}, 200)).Product
	}
	product := create("release-product", model("1.0.0"))
	resource := "/api/console/v1/products/" + product.ID
	input := control.ModelPublishInput{Key: "release-first", ExpectedRevision: product.Revision, Visibility: "public"}
	publish := func(v control.ModelPublishInput) control.ModelPublishOperation {
		return decode[control.ModelPublishOperation](t, c.call("POST", resource+"/releases", v, 200))
	}
	query := func(key string) control.ModelPublishOperation {
		return decode[control.ModelPublishOperation](t, c.call("GET", "/api/console/v1/release-operations/by-key/"+key, nil, 200))
	}
	save := func(key string, raw json.RawMessage) {
		product = decode[control.ProductOperation](t, c.call("POST", resource+"/drafts", control.ProductWrite{Key: key, Name: product.Name, Model: raw, ExpectedRevision: product.Revision}, 200)).Product
	}
	assertSame := func(a, b any) {
		aDigest, aErr := control.CanonicalDigest(a)
		bDigest, bErr := control.CanonicalDigest(b)
		if aErr != nil || bErr != nil || aDigest != bDigest {
			t.Fatal("immutable decision or publication changed")
		}
	}
	anon := newClient(t, server.URL)
	anon.call("GET", "/api/console/v1/publisher", nil, 401)
	anon.call("GET", resource+"/releases", nil, 401)
	anon.call("POST", resource+"/releases", input, 401)
	c.request("POST", resource+"/releases", input, 403, "https://other.invalid", true)
	c.request("POST", resource+"/releases", input, 403, server.URL, false)
	for _, bad := range []json.RawMessage{
		json.RawMessage(fmt.Sprintf(`{"request_key":"bad","expected_revision":%q,"visibility":"public"}`, product.Revision)),
		json.RawMessage(fmt.Sprintf(`{"request_key":"bad","expected_revision":%q,"visibility":"private","expected_release_id":null}`, product.Revision)),
		json.RawMessage(fmt.Sprintf(`{"request_key":"bad","expected_revision":%q,"visibility":"public","expected_release_id":null,"namespace":"xiaomi"}`, product.Revision)),
		json.RawMessage(fmt.Sprintf(`{"request_key":"bad","request_key":"bad","expected_revision":%q,"visibility":"public","expected_release_id":null}`, product.Revision)),
	} {
		c.call("POST", resource+"/releases", bad, 400)
	}
	first := publish(input)
	if first.Status != "published" || first.Release == nil || first.Reason != nil || first.Compatibility != nil || first.Release.Artifact.Statement.Baseline != nil || first.SourceRevision != product.Revision {
		t.Fatal("first publication not durably published against explicit empty baseline")
	}
	statement := first.Release.Artifact.Statement
	if statement.PublisherID != publisher.ID || statement.Namespace != publisher.Namespace || statement.SourceDocumentDigest != product.DocumentDigest || statement.ModelRevision == product.DocumentDigest {
		t.Fatal("publisher, source or normalized model binding lost")
	}
	verify := func(publication control.ModelPublication) {
		a, _ := json.Marshal(publication.Artifact)
		trust, _ := json.Marshal(publication.Trust)
		report, err := control.NewModelValidator(validatorPath).VerifyRelease(context.Background(), a, trust)
		if err != nil || report.Valid == nil || !*report.Valid {
			t.Fatalf("Go published artifact failed shared Rust verifier: %v", err)
		}
	}
	verify(*first.Release)
	assertSame(first, publish(input))
	assertSame(first, query(input.Key))
	otherInput := input
	otherInput.ExpectedRevision = "prodrev-" + control.Random()
	c.call("POST", resource+"/releases", otherInput, 409)
	publicPath := "/api/catalog/v1/model-releases/" + statement.ReleaseID
	publicRaw := anon.call("GET", publicPath, nil, 200)
	assertSame(*first.Release, decode[control.ModelPublication](t, publicRaw))
	if bytes.Contains(publicRaw, []byte(actor.ID)) || bytes.Contains(publicRaw, []byte("model-release-owner")) || bytes.Contains(publicRaw, []byte("发布测试灯")) {
		t.Fatal("public download leaked private principal or draft name")
	}
	assertSame(product, decode[control.Product](t, c.call("GET", resource, nil, 200)))
	other := newClient(t, server.URL)
	other.oidc(p, "console", "model-release-other", "", 303)
	other.session("console")
	other.call("GET", resource+"/releases", nil, 404)
	other.call("POST", resource+"/releases", input, 404)
	other.call("GET", "/api/console/v1/release-operations/by-key/"+input.Key, nil, 404)
	admin := newClient(t, server.URL)
	admin.oidc(p, "admin", "operator", "", 303)
	admin.session("admin")
	admin.call("POST", resource+"/releases", input, 401)
	p.status.Store(503)
	c.call("GET", "/api/console/v1/release-operations/by-key/"+input.Key, nil, 503)
	p.status.Store(0)
	invalid := create("invalid-product", json.RawMessage(`{}`))
	rejected := decode[control.ModelPublishOperation](t, c.call("POST", "/api/console/v1/products/"+invalid.ID+"/releases", control.ModelPublishInput{Key: "invalid-model", ExpectedRevision: invalid.Revision, Visibility: "public"}, 200))
	if rejected.Status != "rejected" || rejected.Release != nil || rejected.Validation == nil || *rejected.Validation.Valid || *rejected.Reason != "invalid_release_model" {
		t.Fatal("invalid model acquired a publication")
	}
	foreign := strings.Replace(string(model("1.0.0")), "urn:"+publisher.Namespace+":model", "urn:limeiot:model", 1)
	foreignProduct := create("foreign-product", json.RawMessage(foreign))
	rejected = decode[control.ModelPublishOperation](t, c.call("POST", "/api/console/v1/products/"+foreignProduct.ID+"/releases", control.ModelPublishInput{Key: "foreign-model", ExpectedRevision: foreignProduct.Revision, Visibility: "public"}, 200))
	if rejected.Status != "rejected" || rejected.Release != nil || *rejected.Reason != "release_model_namespace_mismatch" {
		t.Fatal("self-reported foreign namespace published")
	}
	duplicate := create("duplicate-model-product", model("1.0.0"))
	rejected = decode[control.ModelPublishOperation](t, c.call("POST", "/api/console/v1/products/"+duplicate.ID+"/releases", control.ModelPublishInput{Key: "duplicate-model", ExpectedRevision: duplicate.Revision, Visibility: "public"}, 200))
	if rejected.Status != "rejected" || rejected.Release != nil || *rejected.Reason != "model_id_already_published" {
		t.Fatal("second product took over published model identity")
	}
	// 定义校验有效但向后不兼容，拒绝决定也必须保持不可变。
	badModel := model("1.0.1")
	var incompatible map[string]any
	if json.Unmarshal(badModel, &incompatible) != nil {
		t.Fatal("invalid fixture")
	}
	incompatible["services"].([]any)[0].(map[string]any)["properties"].([]any)[0].(map[string]any)["schema"] = map[string]any{"type": "string"}
	badModel, _ = json.Marshal(incompatible)
	save("save-incompatible", badModel)
	headID := statement.ReleaseID
	badInput := control.ModelPublishInput{Key: "incompatible-model", ExpectedRevision: product.Revision, ExpectedReleaseID: &headID, Visibility: "public"}
	rejected = publish(badInput)
	if rejected.Status != "rejected" || rejected.Release != nil || rejected.Compatibility == nil || *rejected.Compatibility.Compatible {
		t.Fatal("incompatible definition advanced release head")
	}
	save("save-compatible", model("1.0.1"))
	assertSame(rejected, publish(badInput))
	// 两个并发发布使用同一发布头，只有一个能提交，另一个成为永久冲突。
	var wg sync.WaitGroup
	results := make(chan control.ModelPublishOperation, 2)
	for i := range 2 {
		wg.Go(func() {
			results <- publish(control.ModelPublishInput{Key: fmt.Sprintf("release-race-%d", i), ExpectedRevision: product.Revision, ExpectedReleaseID: &headID, Visibility: "public"})
		})
	}
	wg.Wait()
	close(results)
	counts := map[string]int{}
	var upgrade control.ModelPublishOperation
	for result := range results {
		counts[result.Status]++
		if result.Status == "published" {
			upgrade = result
		} else if result.Release != nil || result.Validation != nil || result.Compatibility != nil || result.Reason == nil || *result.Reason != "release_baseline_conflict" {
			t.Fatal("concurrent conflict retained a stale signature or report")
		}
		assertSame(result, query(result.Input.Key))
	}
	if counts["published"] != 1 || counts["conflict"] != 1 || upgrade.Release.Artifact.Statement.Baseline.ReleaseID != headID {
		t.Fatal("concurrent publication bypassed baseline")
	}
	verify(*upgrade.Release)
	// 以已经验证的候选模拟校验后发生编辑，提交层必须独立复核并清除候选签名。
	candidate := upgrade
	candidate.ID, candidate.Input.Key = "relop-"+control.Random(), "edit-during-validation"
	candidate.Digest, _ = control.CanonicalDigest(candidate.Input)
	save("save-during-validation", model("1.0.2"))
	stale, err := store.CommitModelPublication(context.Background(), candidate)
	if err != nil || stale.Status != "conflict" || stale.Release != nil || stale.Validation != nil || stale.Compatibility != nil || *stale.Reason != "draft_revision_conflict" {
		t.Fatalf("candidate survived an edit between validation and commit: %v", err)
	}
	// 发布、原决定和审计任何一步失败都整体回滚；不留下可下载的孤立制品。
	if _, err = store.DB.Exec(`RENAME TABLE control_audit TO control_audit_publication_unavailable`); err != nil {
		t.Fatal(err)
	}
	auditUnavailable := true
	defer func() {
		if auditUnavailable {
			_, _ = store.DB.Exec(`RENAME TABLE control_audit_publication_unavailable TO control_audit`)
		}
	}()
	nextHead := upgrade.Release.Artifact.Statement.ReleaseID
	nextInput := control.ModelPublishInput{Key: "audit-failure", ExpectedRevision: product.Revision, ExpectedReleaseID: &nextHead, Visibility: "public"}
	c.call("POST", resource+"/releases", nextInput, 503)
	c.call("GET", "/api/console/v1/release-operations/by-key/"+nextInput.Key, nil, 404)
	page := decode[control.ModelPublicationPage](t, c.call("GET", resource+"/releases", nil, 200))
	if len(page.Items) != 2 {
		t.Fatal("audit failure left a public release behind")
	}
	if _, err = store.DB.Exec(`RENAME TABLE control_audit_publication_unavailable TO control_audit`); err != nil {
		t.Fatal(err)
	}
	auditUnavailable = false
	// 发布列表超过一页，按合同游标穷尽，不以按时间排序替代稳定ID游标。
	for i := 2; i <= 17; i++ {
		if i > 2 {
			save(fmt.Sprintf("save-version-%d", i), model(fmt.Sprintf("1.0.%d", i)))
		}
		operation := publish(control.ModelPublishInput{Key: fmt.Sprintf("release-version-%d", i), ExpectedRevision: product.Revision, ExpectedReleaseID: &nextHead, Visibility: "public"})
		if operation.Status != "published" {
			t.Fatal("compatible version rejected")
		}
		nextHead = operation.Release.Artifact.Statement.ReleaseID
	}
	ids, after := []string{}, ""
	for {
		page := decode[control.ModelPublicationPage](t, c.call("GET", resource+"/releases?after="+after, nil, 200))
		for _, item := range page.Items {
			id := item.Artifact.Statement.ReleaseID
			if len(ids) > 0 && id <= ids[len(ids)-1] {
				t.Fatal("duplicate or unordered release pagination")
			}
			ids = append(ids, id)
		}
		if page.Next == nil {
			break
		}
		after = *page.Next
	}
	if len(ids) != 18 {
		t.Fatal("release pagination lost immutable versions")
	}
	assertSame(*first.Release, decode[control.ModelPublication](t, anon.call("GET", publicPath, nil, 200)))
	// 新应用实例没有签名器或校验器，旧会话、原决定和公开制品仍能只读恢复。
	cfg.ModelReleaseKeyFile, cfg.ModelValidatorPath = "", filepath.Join(t.TempDir(), "missing-validator")
	restarted, err := control.New(cfg, control.Dependencies{Sessions: store, Registry: store, Machines: store, Remote: store, Native: store, Products: store, Publications: store, Readiness: store})
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	request := func(method, path string, body any, expected int) []byte {
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest(method, server.URL+path, bytes.NewReader(raw))
		u, _ := url.Parse(server.URL)
		for _, cookie := range c.http.Jar.Cookies(u) {
			r.AddCookie(cookie)
		}
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", server.URL)
		r.Header.Set("X-CSRF-Token", c.csrf["console"])
		rr := httptest.NewRecorder()
		restarted.Handler().ServeHTTP(rr, r)
		if rr.Code != expected {
			t.Fatalf("restarted publication request: expected %d, got %d: %s", expected, rr.Code, rr.Body.Bytes())
		}
		return rr.Body.Bytes()
	}
	assertSame(first, decode[control.ModelPublishOperation](t, request("POST", resource+"/releases", input, 200)))
	assertSame(first, decode[control.ModelPublishOperation](t, request("GET", "/api/console/v1/release-operations/by-key/"+input.Key, nil, 200)))
	assertSame(*first.Release, decode[control.ModelPublication](t, request("GET", publicPath, nil, 200)))
	request("POST", resource+"/releases", control.ModelPublishInput{Key: "no-signer", ExpectedRevision: product.Revision, ExpectedReleaseID: &nextHead, Visibility: "public"}, 503)
	var disabled map[string]any
	if json.Unmarshal(request("GET", "/api/console/v1/publisher", nil, 200), &disabled) != nil || disabled["trust"] != nil {
		t.Fatal("disabled signing key falsely advertised")
	}
	// 只在测试自建数据库填满拒绝历史，满额不清理或改变任何旧决定。
	var count int
	if err = store.DB.QueryRow(`SELECT COUNT(*) FROM control_model_publish_operations WHERE principal_id=?`, actor.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	for i := count; i < 1024; i++ {
		v := stale
		v.ID, v.Input.Key = "relop-"+control.Random(), fmt.Sprintf("quota-%d", i)
		raw, _ := json.Marshal(v)
		if _, err = store.DB.Exec(`INSERT INTO control_model_publish_operations (operation_id,principal_id,product_id,request_key,request_digest,operation_body,created_at) VALUES (?,?,?,?,?,?,?)`, v.ID, actor.ID, product.ID, v.Input.Key, v.Digest, raw, v.Created); err != nil {
			t.Fatal(err)
		}
	}
	full := control.ModelPublishInput{Key: "release-full", ExpectedRevision: first.SourceRevision, Visibility: "public"}
	c.call("POST", resource+"/releases", full, 429)
	assertSame(first, publish(input))
	assertSame(rejected, query(rejected.Input.Key))
	if err := mysqlstore.Check(context.Background(), store.DB); err != nil {
		t.Fatal(err)
	}
}
