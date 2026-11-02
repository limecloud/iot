package control

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type releaseVector struct {
	TestOnly      bool                 `json:"test_only"`
	SeedHex       string               `json:"seed_hex"`
	Principal     string               `json:"principal_id"`
	Trust         ModelReleaseTrust    `json:"trust"`
	Artifact      ModelReleaseArtifact `json:"artifact"`
	Upgrade       ModelReleaseArtifact `json:"upgrade"`
	MessageDigest string               `json:"signing_message_digest"`
}

func releaseFixture(t *testing.T) (releaseVector, []byte) {
	t.Helper()
	raw, err := os.ReadFile("../../../contracts/examples/model-release.json")
	if err != nil {
		t.Fatal(err)
	}
	var f releaseVector
	if json.Unmarshal(raw, &f) != nil || !f.TestOnly {
		t.Fatal("invalid public test vector")
	}
	seed, err := hex.DecodeString(f.SeedHex)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(ed25519.NewKeyFromSeed(seed))
	if err != nil {
		t.Fatal(err)
	}
	return f, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}

func TestModelReleaseSignerMatchesIndependentSignatureVector(t *testing.T) {
	f, encoded := releaseFixture(t)
	signer, err := NewModelReleaseSigner(f.Trust.Issuer, encoded)
	if err != nil {
		t.Fatal(err)
	}
	publisher, err := ModelPublisherFor(f.Trust.Issuer, f.Principal)
	if err != nil {
		t.Fatal(err)
	}
	trust, err := signer.Trust(publisher)
	if err != nil || !reflect.DeepEqual(trust, f.Trust) {
		t.Fatal("publisher or public trust differs from vector")
	}
	for _, artifact := range []ModelReleaseArtifact{f.Artifact, f.Upgrade} {
		signed, err := signer.Sign(artifact.Statement)
		if err != nil {
			t.Fatal(err)
		}
		a, _ := CanonicalDigest(signed)
		b, _ := CanonicalDigest(artifact)
		if a != b {
			t.Fatal("Ed25519/JCS/domain signature differs")
		}
		message, err := modelReleaseSigningMessage(signed)
		if err != nil {
			t.Fatal(err)
		}
		public, _ := base64.StdEncoding.DecodeString(trust.PublicKey)
		signature, _ := base64.StdEncoding.DecodeString(signed.Signature)
		if !ed25519.Verify(ed25519.PublicKey(public), message, signature) {
			t.Fatal("signature not independently verifiable")
		}
	}
	message, _ := modelReleaseSigningMessage(f.Artifact)
	if "sha256:"+Hash(string(message)) != f.MessageDigest {
		t.Fatal("signed message differs from independent fixture")
	}
	other, err := ModelPublisherFor("https://other.example.test", f.Principal)
	if err != nil || other.ID == publisher.ID || other.Namespace == publisher.Namespace {
		t.Fatal("publisher identity is not scoped to issuer")
	}
	if _, err := ModelPublisherFor(f.Trust.Issuer, "untrusted-subject"); err != ErrReleaseSigner {
		t.Fatal("raw identity accepted as publisher")
	}
}

func TestModelReleaseSignerRejectsKeyConfusionAndSnapshotsInputs(t *testing.T) {
	f, encoded := releaseFixture(t)
	ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ecDER, err := x509.MarshalPKCS8PrivateKey(ec)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]byte{nil, []byte("secret"), []byte(strings.Repeat("x", 8193)), append(append([]byte{}, encoded...), encoded...), append(append([]byte{}, encoded...), []byte("trailing")...), append([]byte("leading garbage\n"), encoded...), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: ecDER}), pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: []byte("not-private")})} {
		if _, err := NewModelReleaseSigner(f.Trust.Issuer, bad); err != ErrReleaseSigner {
			t.Fatal("wrong or ambiguous key accepted")
		}
	}
	signer, err := NewModelReleaseSigner(f.Trust.Issuer, encoded)
	if err != nil {
		t.Fatal(err)
	}
	clear(encoded)
	statement := f.Upgrade.Statement
	signed, err := signer.Sign(statement)
	if err != nil {
		t.Fatal(err)
	}
	digest, _ := CanonicalDigest(signed)
	statement.Model[0] = '['
	statement.Baseline.ReleaseID = "changed"
	after, _ := CanonicalDigest(signed)
	if digest != after {
		t.Fatal("mutable input changed signed artifact")
	}
	bad := f.Artifact.Statement
	bad.Issuer = "https://other.example.test"
	if _, err := signer.Sign(bad); err != ErrReleaseSigner {
		t.Fatal("cross issuer signing accepted")
	}
	bad = f.Artifact.Statement
	bad.Namespace = "limeiot"
	if _, err := signer.Sign(bad); err != ErrReleaseSigner {
		t.Fatal("reserved namespace accepted")
	}
	if _, err := signer.Trust(ModelPublisher{ID: f.Trust.PublisherID, Namespace: "xiaomi"}); err != ErrReleaseSigner {
		t.Fatal("arbitrary publisher namespace accepted")
	}
	var missing *ModelReleaseSigner
	if _, err := missing.Sign(f.Artifact.Statement); err != ErrReleaseSigner {
		t.Fatal("missing signer accepted")
	}
}

func TestModelReleaseRustProcessAndReportBindings(t *testing.T) {
	validator := comparisonValidator(t)
	f, encoded := releaseFixture(t)
	signer, err := NewModelReleaseSigner(f.Trust.Issuer, encoded)
	if err != nil {
		t.Fatal(err)
	}
	trust, _ := json.Marshal(f.Trust)
	var good ModelReleaseVerification
	for _, artifact := range []ModelReleaseArtifact{f.Artifact, f.Upgrade} {
		raw, _ := json.Marshal(artifact)
		report, err := validator.VerifyRelease(context.Background(), raw, trust)
		if err != nil || report.Valid == nil || !*report.Valid || len(report.Issues) != 0 {
			t.Fatalf("valid signed release rejected: %v", err)
		}
		good = report
	}
	bad := f.Artifact
	var model map[string]any
	if json.Unmarshal(bad.Statement.Model, &model) != nil {
		t.Fatal("invalid model fixture")
	}
	model["schema_version"] = 3
	bad.Statement.Validator = "limeiot.model/1.1.0"
	bad.Statement.CompatibilityChecker = "limeiot.model-compatibility/1.1.0"
	bad.Statement.Model, _ = json.Marshal(model)
	bad, err = signer.Sign(bad.Statement)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(bad)
	report, err := validator.VerifyRelease(context.Background(), raw, trust)
	if err != nil || report.Valid == nil || *report.Valid || !bytes.Equal(report.Release, []byte("null")) || len(report.Issues) != 1 || report.Issues[0].Code != "invalid_release_model" {
		t.Fatalf("signature over invalid model trusted: %v", err)
	}
	valid, _ := json.Marshal(good)
	for _, mutate := range []func(map[string]any){
		func(v map[string]any) { v["artifact_digest"] = "sha256:wrong" },
		func(v map[string]any) { v["trust_digest"] = "sha256:wrong" },
		func(v map[string]any) { v["release"] = nil },
		func(v map[string]any) { v["valid"] = false },
		func(v map[string]any) { v["extra"] = true },
		func(v map[string]any) { delete(v, "issues") },
		func(v map[string]any) { v["issues"] = []any{map[string]any{"code": "invalid", "path": nil}} },
		func(v map[string]any) {
			v["release"].(map[string]any)["statement"].(map[string]any)["source_revision"] = "changed"
		},
	} {
		var value map[string]any
		if json.Unmarshal(valid, &value) != nil {
			t.Fatal("invalid report fixture")
		}
		mutate(value)
		forged, _ := json.Marshal(value)
		if _, err := checkedReleaseReport(forged, good.ArtifactDigest, good.TrustDigest); err != ErrValidatorUnavailable {
			t.Fatal("forged verifier report accepted")
		}
	}
}

func TestModelReleaseKeyFileIsExplicitPrivateAndPersistent(t *testing.T) {
	f, encoded := releaseFixture(t)
	signer, err := loadModelReleaseSigner(f.Trust.Issuer, "")
	if err != nil || signer != nil {
		t.Fatal("missing configuration auto-created a signing identity")
	}
	directory := t.TempDir()
	for _, test := range []struct {
		name string
		body []byte
		mode os.FileMode
	}{
		{"private.pem", encoded, 0600},
		{"publicly-readable.pem", encoded, 0644},
		{"wrong-key.pem", []byte("not a key"), 0600},
		{"oversized.pem", bytes.Repeat([]byte("x"), 8193), 0600},
	} {
		path := filepath.Join(directory, test.name)
		if err := os.WriteFile(path, test.body, test.mode); err != nil {
			t.Fatal(err)
		}
		signer, err := loadModelReleaseSigner(f.Trust.Issuer, path)
		if test.name == "private.pem" {
			if err != nil || signer == nil {
				t.Fatal("valid explicit private signing key rejected")
			}
			artifact, err := signer.Sign(f.Artifact.Statement)
			if err != nil || artifact.Signature != f.Artifact.Signature {
				t.Fatal("file configuration changed signing identity")
			}
		} else if err != ErrReleaseSigner || signer != nil {
			t.Fatalf("unsafe signing file accepted: %s", test.name)
		}
	}
	for _, path := range []string{directory, filepath.Join(directory, "missing.pem")} {
		if _, err := loadModelReleaseSigner(f.Trust.Issuer, path); err != ErrReleaseSigner {
			t.Fatal("invalid configured path silently disabled signing")
		}
	}
}
