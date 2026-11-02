package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gowebpki/jcs"
)

var ErrValidatorUnavailable = errors.New("validator_unavailable")

type ModelIssue struct {
	Path string `json:"path"`
	Code string `json:"code"`
}
type ModelReport struct {
	Version         int             `json:"version"`
	Validator       string          `json:"validator"`
	Valid           *bool           `json:"valid"`
	DocumentDigest  *string         `json:"document_digest"`
	ModelRevision   *string         `json:"model_revision"`
	NormalizedModel json.RawMessage `json:"normalized_model"`
	Issues          []ModelIssue    `json:"issues"`
}

// ModelValidator 隔离独立Rust组件；Go不实现第二套物模型语义。
type ModelValidator interface {
	Validate(context.Context, json.RawMessage) (ModelReport, error)
	Compare(context.Context, json.RawMessage, json.RawMessage) (ModelComparison, error)
	VerifyRelease(context.Context, json.RawMessage, json.RawMessage) (ModelReleaseVerification, error)
}
type processValidator struct {
	path  string
	slots chan struct{}
}

func NewModelValidator(path string) ModelValidator {
	if path == "" {
		path, _ = exec.LookPath("limeiot-model-validator")
	}
	if !filepath.IsAbs(path) {
		path = ""
	}
	return &processValidator{path: path, slots: make(chan struct{}, 4)}
}

type boundedOutput struct{ bytes.Buffer }

func (out *boundedOutput) Write(p []byte) (int, error) {
	if out.Len()+len(p) > 65536 {
		return 0, ErrValidatorUnavailable
	}
	return out.Buffer.Write(p)
}

var modelIssueCode = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
var modelIssuePath = regexp.MustCompile(`^(?:/(?:[^~/]|~[01])*)*$`)

func checkedModelReport(raw []byte, documentDigest string) (ModelReport, error) {
	var report ModelReport
	var fields map[string]json.RawMessage
	if len(raw) > 65536 {
		return report, ErrValidatorUnavailable
	}
	// JCS同时拒绝重复字段与非法Unicode；不把解析器错误或子进程输出写回客户端。
	if _, err := jcs.Transform(raw); err != nil {
		return report, ErrValidatorUnavailable
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if json.Unmarshal(raw, &fields) != nil || len(fields) != 7 || !completeIssues(fields["issues"]) || decoder.Decode(&report) != nil || decoder.Decode(new(any)) != io.EOF || report.Version != 1 || report.Validator != "limeiot.model/1.1.0" || report.Valid == nil || report.DocumentDigest == nil || *report.DocumentDigest != documentDigest || report.Issues == nil || len(report.Issues) > 32 {
		return ModelReport{}, ErrValidatorUnavailable
	}
	for _, issue := range report.Issues {
		if len(issue.Path) > 1024 || !modelIssuePath.MatchString(issue.Path) || !modelIssueCode.MatchString(issue.Code) {
			return ModelReport{}, ErrValidatorUnavailable
		}
	}
	if *report.Valid {
		model, digest, err := productDocument(report.NormalizedModel)
		if err != nil || report.ModelRevision == nil || *report.ModelRevision != digest || len(report.Issues) != 0 {
			return ModelReport{}, ErrValidatorUnavailable
		}
		report.NormalizedModel = model
	} else if report.ModelRevision != nil || !bytes.Equal(bytes.TrimSpace(report.NormalizedModel), []byte("null")) || len(report.Issues) == 0 {
		return ModelReport{}, ErrValidatorUnavailable
	}
	return report, nil
}

func completeIssues(raw json.RawMessage) bool {
	var issues []map[string]json.RawMessage
	if json.Unmarshal(raw, &issues) != nil || issues == nil || len(issues) > 32 {
		return false
	}
	for _, issue := range issues {
		if len(issue) != 2 || issue["path"] == nil || issue["code"] == nil || bytes.Equal(bytes.TrimSpace(issue["path"]), []byte("null")) || bytes.Equal(bytes.TrimSpace(issue["code"]), []byte("null")) {
			return false
		}
	}
	return true
}

func (v *processValidator) Validate(ctx context.Context, raw json.RawMessage) (ModelReport, error) {
	model, digest, err := productDocument(raw)
	if err != nil {
		return ModelReport{}, ErrValidatorUnavailable
	}
	out, code, err := v.run(ctx, model, nil)
	if err != nil {
		return ModelReport{}, err
	}
	report, err := checkedModelReport(out, digest)
	if err != nil || (*report.Valid) != (code == 0) {
		return ModelReport{}, ErrValidatorUnavailable
	}
	return report, nil
}

// 固定模式共用有界并发和截止时间，参数只能由本适配器选择。
func (v *processValidator) run(ctx context.Context, model []byte, args []string) ([]byte, int, error) {
	if v.path == "" {
		return nil, 0, ErrValidatorUnavailable
	}
	select {
	case v.slots <- struct{}{}:
		defer func() { <-v.slots }()
	default:
		return nil, 0, ErrValidatorUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, v.path, args...)
	cmd.Env = []string{}
	cmd.Stdin = bytes.NewReader(model)
	cmd.Stderr = io.Discard
	var out boundedOutput
	cmd.Stdout = &out
	cmd.WaitDelay = 200 * time.Millisecond
	err := cmd.Run()
	code := 0
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 2 {
			return nil, 0, ErrValidatorUnavailable
		}
		code = 2
	}
	return out.Bytes(), code, nil
}

func (s *Server) validateModel(c *gin.Context) {
	if _, _, ok := s.authenticated(c, "console"); !ok {
		return
	}
	if !s.allowed(c, "models.validate") {
		return
	}
	var input struct {
		Model json.RawMessage `json:"model"`
	}
	if !productBody(c, &input) {
		return
	}
	model, _, err := productDocument(input.Model)
	if err != nil {
		fail(c, 400, "invalid_draft_document")
		return
	}
	report, err := s.modelValidator.Validate(c.Request.Context(), model)
	if err != nil {
		fail(c, 503, "validator_unavailable")
		return
	}
	c.JSON(200, report)
}
