package control

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/gowebpki/jcs"
)

func comparisonValidator(t *testing.T) ModelValidator {
	t.Helper()
	path := os.Getenv("LIMEIOT_MODEL_VALIDATOR")
	if path == "" {
		t.Skip("set LIMEIOT_MODEL_VALIDATOR to the built Rust companion")
	}
	return NewModelValidator(path)
}

func TestModelComparisonSharedVectors(t *testing.T) {
	validator := comparisonValidator(t)
	raw, err := os.ReadFile("../../../contracts/model-compatibility-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Cases []struct {
			Name, Raw, Code string
			Valid           bool
			Compatible      *bool
		}
	}
	if json.Unmarshal(raw, &vectors) != nil {
		t.Fatal("invalid comparison vectors")
	}
	for _, tc := range vectors.Cases {
		var input struct{ Baseline, Candidate json.RawMessage }
		if json.Unmarshal([]byte(tc.Raw), &input) != nil {
			t.Fatal(tc.Name)
		}
		report, err := validator.Compare(context.Background(), input.Baseline, input.Candidate)
		if err != nil || report.Valid == nil || *report.Valid != tc.Valid || (report.Compatible == nil) != (tc.Compatible == nil) || report.Compatible != nil && *report.Compatible != *tc.Compatible {
			t.Fatalf("%s: invalid comparison: %v", tc.Name, err)
		}
		if tc.Code != "" {
			found := false
			for _, issue := range report.Issues {
				found = found || issue.Code == tc.Code
			}
			if !found {
				t.Fatalf("%s: missing issue %s", tc.Name, tc.Code)
			}
		}
	}
}

func TestModelComparisonLongFieldIsInvalidModelInsteadOfComponentFailure(t *testing.T) {
	validator := comparisonValidator(t)
	model := map[string]any{"schema_version": 1, "model_id": "urn:example:model:test:1", "model_version": "1.0.0", "services": []any{map[string]any{"id": "test", "semantic_id": "urn:example:service:test:1", "properties": []any{map[string]any{"id": "text", "semantic_id": "urn:example:property:text:1", "schema": map[string]any{"type": "object", "properties": map[string]any{strings.Repeat("界/~", 400): map[string]any{"type": "boolean"}}}, "access": []string{"read"}, "max_age_ms": 1}}, "actions": []any{}, "events": []any{}}}}
	raw, _ := json.Marshal(model)
	report, err := validator.Compare(context.Background(), raw, raw)
	if err != nil || report.Valid == nil || *report.Valid || report.Compatible != nil {
		t.Fatalf("long input key became component failure: %v", err)
	}
	for _, sub := range []ModelReport{report.Baseline, report.Candidate} {
		if len(sub.Issues) != 1 || sub.Issues[0].Path != "/services/0/properties/0/schema/properties" || sub.Issues[0].Code != "invalid_identifier" {
			t.Fatal("unbounded or incorrect issue pointer")
		}
	}
}

func TestModelComparisonCanonicalInputAndForgedReports(t *testing.T) {
	validator := comparisonValidator(t)
	// Go默认HTML转义会膨胀原文；组件接收JCS输入，仍遵守相同大小预算。
	model := func(version string) json.RawMessage {
		v := map[string]any{"schema_version": 1, "model_id": "urn:example:model:test:1", "model_version": version, "services": []any{map[string]any{"id": "test", "semantic_id": "urn:example:service:test:1", "properties": []any{map[string]any{"id": "text", "semantic_id": "urn:example:property:text:1", "schema": map[string]any{"type": "string", "enum": []string{strings.Repeat("<>&", 1000)}}, "access": []string{"read", "write"}, "max_age_ms": 1}}, "actions": []any{}, "events": []any{}}}}
		raw, _ := json.Marshal(v)
		canonical, err := jcs.Transform(raw)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := productDocument(canonical); err != nil {
			t.Fatal(err)
		}
		return canonical
	}
	old, next := model("1.0.0"), model("1.0.1")
	good, err := validator.Compare(context.Background(), old, next)
	if err != nil || good.Compatible == nil || !*good.Compatible {
		t.Fatalf("canonical comparison: %v", err)
	}
	inputDigest, oldDigest, nextDigest := good.ComparisonDigest, *good.Baseline.DocumentDigest, *good.Candidate.DocumentDigest
	raw, _ := json.Marshal(good)
	for _, mutate := range []func(map[string]any){
		func(v map[string]any) { v["comparison_digest"] = "sha256:wrong" },
		func(v map[string]any) { v["valid"] = false },
		func(v map[string]any) { v["compatible"] = nil },
		func(v map[string]any) { v["extra"] = true },
		func(v map[string]any) { delete(v, "issues") },
		func(v map[string]any) { v["issues"] = []any{map[string]any{"code": "unsafe"}} },
		func(v map[string]any) { v["issues"] = []any{map[string]any{"path": nil, "code": "unsafe"}} },
		func(v map[string]any) { v["baseline"] = nil },
		func(v map[string]any) { v["baseline"].(map[string]any)["document_digest"] = nextDigest },
		func(v map[string]any) { delete(v["candidate"].(map[string]any), "model_revision") },
		func(v map[string]any) { v["candidate"].(map[string]any)["model_revision"] = oldDigest },
	} {
		var value map[string]any
		if json.Unmarshal(raw, &value) != nil {
			t.Fatal("invalid fixture")
		}
		mutate(value)
		forged, _ := json.Marshal(value)
		if _, err := checkedComparisonReport(forged, inputDigest, oldDigest, nextDigest); err != ErrValidatorUnavailable {
			t.Fatal("forged comparison accepted")
		}
	}
	duplicated := append([]byte(`{"version":1,`), raw[1:]...)
	if _, err := checkedComparisonReport(duplicated, inputDigest, oldDigest, nextDigest); err != ErrValidatorUnavailable {
		t.Fatal("duplicate report key accepted")
	}
}
