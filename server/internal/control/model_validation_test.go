package control

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if kind, ok := strings.CutPrefix(filepath.Base(os.Args[0]), "limeiot-validator-helper-"); ok {
		switch kind {
		case "timeout":
			time.Sleep(10 * time.Second)
		case "oversize":
			fmt.Print(strings.Repeat("x", 65537))
		case "error":
			fmt.Fprint(os.Stderr, "private internal diagnostic")
			os.Exit(5)
		case "forged":
			fmt.Print(`{"version":1,"validator":"limeiot.model/1.1.0","valid":true,"document_digest":"wrong","model_revision":null,"normalized_model":{},"issues":[]}`)
		default:
			fmt.Print(`{}`)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestModelValidatorProcessBoundaries(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"timeout", "oversize", "error", "forged", "invalid"} {
		t.Run(kind, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "limeiot-validator-helper-"+kind)
			if err := os.Symlink(executable, path); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			if _, err := NewModelValidator(path).Validate(ctx, json.RawMessage(`{}`)); err != ErrValidatorUnavailable {
				t.Fatalf("untrusted process accepted: %v", err)
			}
			compareCtx, cancelCompare := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancelCompare()
			if _, err := NewModelValidator(path).Compare(compareCtx, json.RawMessage(`{}`), json.RawMessage(`{}`)); err != ErrValidatorUnavailable {
				t.Fatalf("untrusted comparison process accepted: %v", err)
			}
			verifyCtx, cancelVerify := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancelVerify()
			if _, err := NewModelValidator(path).VerifyRelease(verifyCtx, json.RawMessage(`{}`), json.RawMessage(`{}`)); err != ErrValidatorUnavailable {
				t.Fatalf("untrusted release verifier accepted: %v", err)
			}
		})
	}
	v := NewModelValidator(filepath.Join(t.TempDir(), "missing")).(*processValidator)
	if _, err := v.Validate(context.Background(), json.RawMessage(`{}`)); err != ErrValidatorUnavailable {
		t.Fatal(err)
	}
	v.path = executable
	for range cap(v.slots) {
		v.slots <- struct{}{}
	}
	if _, err := v.Validate(context.Background(), json.RawMessage(`{}`)); err != ErrValidatorUnavailable {
		t.Fatal("unbounded process concurrency")
	}
	if _, err := v.Compare(context.Background(), json.RawMessage(`{}`), json.RawMessage(`{}`)); err != ErrValidatorUnavailable {
		t.Fatal("separate concurrency budget for comparison")
	}
	if _, err := v.VerifyRelease(context.Background(), json.RawMessage(`{}`), json.RawMessage(`{}`)); err != ErrValidatorUnavailable {
		t.Fatal("separate concurrency budget for release verification")
	}
}

func TestModelValidatorSharedVectors(t *testing.T) {
	path := os.Getenv("LIMEIOT_MODEL_VALIDATOR")
	if path == "" {
		t.Skip("set LIMEIOT_MODEL_VALIDATOR to the built Rust companion")
	}
	raw, err := os.ReadFile("../../../contracts/model-validation-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Cases []struct {
			Name, Raw string
			Valid     bool
		}
	}
	if json.Unmarshal(raw, &vectors) != nil {
		t.Fatal("invalid shared vectors")
	}
	validator := NewModelValidator(path)
	for _, tc := range vectors.Cases {
		// API先执行通用JSON安全检查；仅将安全文档送入语义组件。
		canonical, _, err := productDocument(json.RawMessage(tc.Raw))
		if err != nil {
			if tc.Valid {
				t.Fatal(tc.Name)
			}
			continue
		}
		report, err := validator.Validate(context.Background(), canonical)
		if err != nil || report.Valid == nil || *report.Valid != tc.Valid {
			t.Fatalf("%s: %v", tc.Name, err)
		}
	}
}
