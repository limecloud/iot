package control

import (
	"bytes"
	"context"
	"encoding/json"
	"io"

	"github.com/gin-gonic/gin"
	"github.com/gowebpki/jcs"
)

type ModelComparison struct {
	Version          int          `json:"version"`
	Checker          string       `json:"checker"`
	Valid            *bool        `json:"valid"`
	Compatible       *bool        `json:"compatible"`
	ComparisonDigest string       `json:"comparison_digest"`
	Baseline         ModelReport  `json:"baseline"`
	Candidate        ModelReport  `json:"candidate"`
	Issues           []ModelIssue `json:"issues"`
}

func checkedComparisonReport(raw []byte, inputDigest, baselineDigest, candidateDigest string) (ModelComparison, error) {
	var report ModelComparison
	var fields map[string]json.RawMessage
	if len(raw) > 65536 {
		return report, ErrValidatorUnavailable
	}
	if _, err := jcs.Transform(raw); err != nil {
		return report, ErrValidatorUnavailable
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if json.Unmarshal(raw, &fields) != nil || len(fields) != 8 || !completeIssues(fields["issues"]) || decoder.Decode(&report) != nil || decoder.Decode(new(any)) != io.EOF || report.Version != 1 || report.Checker != "limeiot.model-compatibility/1.1.0" || report.Valid == nil || report.ComparisonDigest != inputDigest || report.Issues == nil || len(report.Issues) > 32 {
		return ModelComparison{}, ErrValidatorUnavailable
	}
	for _, issue := range report.Issues {
		if len(issue.Path) > 1024 || !modelIssuePath.MatchString(issue.Path) || !modelIssueCode.MatchString(issue.Code) {
			return ModelComparison{}, ErrValidatorUnavailable
		}
	}
	baseline, err := checkedModelReport(fields["baseline"], baselineDigest)
	if err != nil {
		return ModelComparison{}, err
	}
	candidate, err := checkedModelReport(fields["candidate"], candidateDigest)
	if err != nil || *report.Valid != (*baseline.Valid && *candidate.Valid) {
		return ModelComparison{}, ErrValidatorUnavailable
	}
	if *report.Valid {
		if report.Compatible == nil || *report.Compatible != (len(report.Issues) == 0) {
			return ModelComparison{}, ErrValidatorUnavailable
		}
	} else if report.Compatible != nil || len(report.Issues) == 0 {
		return ModelComparison{}, ErrValidatorUnavailable
	}
	report.Baseline, report.Candidate = baseline, candidate
	return report, nil
}

func (v *processValidator) Compare(ctx context.Context, baseline, candidate json.RawMessage) (ModelComparison, error) {
	old, oldDigest, err := productDocument(baseline)
	if err != nil {
		return ModelComparison{}, ErrValidatorUnavailable
	}
	next, nextDigest, err := productDocument(candidate)
	if err != nil {
		return ModelComparison{}, ErrValidatorUnavailable
	}
	input := struct {
		Baseline  json.RawMessage `json:"baseline"`
		Candidate json.RawMessage `json:"candidate"`
	}{old, next}
	raw, err := json.Marshal(input)
	if err != nil {
		return ModelComparison{}, ErrValidatorUnavailable
	}
	raw, err = jcs.Transform(raw)
	if err != nil {
		return ModelComparison{}, ErrValidatorUnavailable
	}
	out, code, err := v.run(ctx, raw, []string{"--compare"})
	if err != nil {
		return ModelComparison{}, err
	}
	report, err := checkedComparisonReport(out, "sha256:"+Hash(string(raw)), oldDigest, nextDigest)
	if err != nil || (report.Compatible != nil && *report.Compatible) != (code == 0) {
		return ModelComparison{}, ErrValidatorUnavailable
	}
	return report, nil
}

func (s *Server) compareModels(c *gin.Context) {
	if _, _, ok := s.authenticated(c, "console"); !ok {
		return
	}
	// 与定义校验共用每地址30次/分钟，避免新增入口扩大组件预算。
	if !s.allowed(c, "models.validate") {
		return
	}
	var raw json.RawMessage
	if !bodyLimit(c, &raw, 16416) {
		return
	}
	if _, err := jcs.Transform(raw); err != nil {
		fail(c, 400, "invalid_comparison_document")
		return
	}
	var input struct {
		Baseline  json.RawMessage `json:"baseline"`
		Candidate json.RawMessage `json:"candidate"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil {
		fail(c, 400, "invalid_request")
		return
	}
	for _, model := range []json.RawMessage{input.Baseline, input.Candidate} {
		if _, _, err := productDocument(model); err != nil {
			fail(c, 400, "invalid_draft_document")
			return
		}
	}
	report, err := s.modelValidator.Compare(c.Request.Context(), input.Baseline, input.Candidate)
	if err != nil {
		fail(c, 503, "validator_unavailable")
		return
	}
	c.JSON(200, report)
}
