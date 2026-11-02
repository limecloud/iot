package control

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProductDocumentBoundaries(t *testing.T) {
	a, digest, err := productDocument(json.RawMessage(`{"z":1.0,"a":{"数":2,"é":true}}`))
	if err != nil {
		t.Fatal(err)
	}
	b, other, err := productDocument(json.RawMessage(`{"a":{"é":true,"数":2},"z":1}`))
	if err != nil || string(a) != string(b) || digest != other || digest != "sha256:"+Hash(string(a)) {
		t.Fatal("equivalent drafts did not canonicalize")
	}
	invalid := []string{`null`, `[]`, `{"a":1,"a":2}`, `{"a":{"b":1,"b":2}}`, `{"n":9007199254740992}`, `{"n":-9007199254740992}`, `{"n":1e400}`, `{"a":"` + strings.Repeat("x", 8192) + `"}`, `{"a":` + strings.Repeat("[", 17) + `0` + strings.Repeat("]", 17) + `}`, `{"a":[` + strings.Repeat(`0,`, 2047) + `0]}`, string([]byte{'{', '"', 'x', '"', ':', '"', 0xff, '"', '}'})}
	for _, raw := range invalid {
		if _, _, err := productDocument(json.RawMessage(raw)); err == nil {
			t.Fatalf("invalid draft accepted: %.80s", raw)
		}
	}
	for _, raw := range []string{`{}`, `{"n":9007199254740991}`, `{"n":-9007199254740991}`, `{"n":1.25}`} {
		if _, _, err := productDocument(json.RawMessage(raw)); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := productDocument(json.RawMessage(`{"s":"\ud800"}`)); err == nil {
		t.Fatal("unpaired surrogate accepted")
	}
}
