package control

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestCanonicalRemoteInputAndBoundReceipt(t *testing.T) {
	a, err := CanonicalDigest(json.RawMessage(`{"z":1.0,"a":{"数":2,"é":true}}`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := CanonicalDigest(json.RawMessage(`{"a":{"é":true,"数":2},"z":1}`))
	if err != nil || a != b {
		t.Fatal("equivalent JSON differs")
	}
	if _, err := CanonicalDigest(json.RawMessage(`{"a":1,"a":2}`)); err == nil {
		t.Fatal("duplicate members accepted")
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	original := RemoteCommand{ID: "remote-test", LocalSpaceID: "local", Input: RemoteInput{DeviceID: "lamp", ModelRevision: "sha256:" + Hash("model"), Expires: now, Operation: RemoteOperation{Type: "property.set", Path: "light.power", Value: json.RawMessage(`true`)}}}
	request := map[string]any{"space_id": "local", "idempotency_key": original.ID, "device_id": "lamp", "model_revision": original.Input.ModelRevision, "expires_at": now, "operation": original.Input.Operation}
	raw, _ := json.Marshal(request)
	digest, _ := CanonicalDigest(json.RawMessage(raw))
	receipt := RemoteReceipt{CommandID: "command-test", Request: raw, RequestDigest: "sha256:" + digest, Status: "confirmed", Evidence: json.RawMessage(`{"type":"device_result","reported":{"light.power":true}}`)}
	if !receipt.valid(original) {
		t.Fatal("bound receipt rejected")
	}
	for _, evidence := range []string{`null`, `{"type":"accepted","reported":{"light.power":true}}`, `{"type":"device_result","reported":{"light.power":false}}`} {
		bad := receipt
		bad.Evidence = json.RawMessage(evidence)
		if bad.valid(original) {
			t.Fatal("confirmed without matching device evidence")
		}
	}
	for _, field := range []string{"space_id", "idempotency_key", "device_id", "model_revision", "expires_at", "operation"} {
		copied := map[string]any{}
		for k, v := range request {
			copied[k] = v
		}
		copied[field] = "other"
		if field == "expires_at" {
			copied[field] = now.Add(time.Second)
		}
		if field == "operation" {
			copied[field] = RemoteOperation{Type: "property.set", Path: "light.power", Value: json.RawMessage(`false`)}
		}
		raw, _ := json.Marshal(copied)
		digest, _ := CanonicalDigest(json.RawMessage(raw))
		bad := receipt
		bad.Request = raw
		bad.RequestDigest = "sha256:" + digest
		if bad.valid(original) {
			t.Fatalf("receipt escaped %s", field)
		}
	}
}

func TestRemoteActionReceiptBindsInputAndCompletionScope(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	operation := RemoteOperation{Type: "action.invoke", Path: "remote.press", Value: json.RawMessage(`{"key":"home"}`)}
	original := RemoteCommand{ID: "remote-action", LocalSpaceID: "home", Input: RemoteInput{DeviceID: "tv", ModelRevision: "sha256:" + Hash("model"), Expires: now.Add(5 * time.Second), Operation: operation}}
	request, _ := json.Marshal(map[string]any{"space_id": "home", "idempotency_key": original.ID, "device_id": "tv", "model_revision": original.Input.ModelRevision, "expires_at": original.Input.Expires, "operation": operation})
	requestDigest, _ := CanonicalDigest(json.RawMessage(request))
	inputDigest, _ := CanonicalDigest(operation.Value)
	evidence := map[string]any{"type": "action_result", "path": "remote.press", "input_digest": "sha256:" + inputDigest, "output": map[string]any{}, "completion": "submitted", "observed_at": now}
	raw, _ := json.Marshal(evidence)
	receipt := RemoteReceipt{CommandID: "command-action", Request: request, RequestDigest: "sha256:" + requestDigest, Status: "confirmed", Evidence: raw}
	if !receipt.valid(original) {
		t.Fatal("submitted action evidence rejected")
	}
	for _, test := range []struct {
		field string
		value any
	}{
		{"type", "device_result"}, {"path", "other.press"}, {"input_digest", "sha256:" + Hash("other")},
		{"completion", "executed"}, {"output", nil}, {"observed_at", now.Add(5 * time.Second)},
		{"observed_at", now.Add(-time.Minute)}, {"extra", true},
	} {
		t.Run(test.field, func(t *testing.T) {
			changed := map[string]any{}
			for k, v := range evidence {
				changed[k] = v
			}
			changed[test.field] = test.value
			bad := receipt
			bad.Evidence, _ = json.Marshal(changed)
			if bad.valid(original) {
				t.Fatal("unbound action evidence accepted")
			}
		})
	}
	bad := receipt
	bad.Evidence = json.RawMessage(strings.TrimSuffix(string(raw), "}") + `,"path":"remote.press"}`)
	if bad.valid(original) {
		t.Fatal("duplicate evidence member accepted")
	}
	delete(evidence, "output")
	bad.Evidence, _ = json.Marshal(evidence)
	if bad.valid(original) {
		t.Fatal("missing output accepted")
	}
}
