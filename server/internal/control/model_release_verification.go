package control

import (
	"bytes"
	"context"
	"encoding/json"
	"io"

	"github.com/gowebpki/jcs"
)

type ModelReleaseVerification struct {
	Version        int             `json:"version"`
	Verifier       string          `json:"verifier"`
	Valid          *bool           `json:"valid"`
	ArtifactDigest string          `json:"artifact_digest"`
	TrustDigest    string          `json:"trust_digest"`
	Release        json.RawMessage `json:"release"`
	Issues         []ModelIssue    `json:"issues"`
}

func checkedReleaseReport(raw []byte, artifactDigest, trustDigest string) (ModelReleaseVerification, error) {
	var report ModelReleaseVerification
	var fields map[string]json.RawMessage
	if len(raw) > 65536 {
		return report, ErrValidatorUnavailable
	}
	if _, err := jcs.Transform(raw); err != nil {
		return report, ErrValidatorUnavailable
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if json.Unmarshal(raw, &fields) != nil || len(fields) != 7 || !completeIssues(fields["issues"]) || decoder.Decode(&report) != nil || decoder.Decode(new(any)) != io.EOF || report.Version != 1 || report.Verifier != "limeiot.model-release/1.0.0" || report.Valid == nil || report.ArtifactDigest != artifactDigest || report.TrustDigest != trustDigest {
		return ModelReleaseVerification{}, ErrValidatorUnavailable
	}
	for _, issue := range report.Issues {
		if len(issue.Path) > 1024 || !modelIssuePath.MatchString(issue.Path) || !modelIssueCode.MatchString(issue.Code) {
			return ModelReleaseVerification{}, ErrValidatorUnavailable
		}
	}
	if *report.Valid {
		release, digest, err := boundedObjectDocument(report.Release, 12288, 18, 2304)
		if err != nil || digest != artifactDigest || len(report.Issues) != 0 {
			return ModelReleaseVerification{}, ErrValidatorUnavailable
		}
		report.Release = release
	} else if !bytes.Equal(bytes.TrimSpace(report.Release), []byte("null")) || len(report.Issues) == 0 {
		return ModelReleaseVerification{}, ErrValidatorUnavailable
	}
	return report, nil
}

func (v *processValidator) VerifyRelease(ctx context.Context, artifact, trust json.RawMessage) (ModelReleaseVerification, error) {
	artifact, artifactDigest, err := boundedObjectDocument(artifact, 12288, 18, 2304)
	if err != nil {
		return ModelReleaseVerification{}, ErrValidatorUnavailable
	}
	trust, trustDigest, err := boundedObjectDocument(trust, 2048, 2, 16)
	if err != nil {
		return ModelReleaseVerification{}, ErrValidatorUnavailable
	}
	raw, err := json.Marshal(struct {
		Artifact json.RawMessage `json:"artifact"`
		Trust    json.RawMessage `json:"trust"`
	}{artifact, trust})
	if err != nil {
		return ModelReleaseVerification{}, ErrValidatorUnavailable
	}
	raw, err = jcs.Transform(raw)
	if err != nil {
		return ModelReleaseVerification{}, ErrValidatorUnavailable
	}
	out, code, err := v.run(ctx, raw, []string{"--verify-release"})
	if err != nil {
		return ModelReleaseVerification{}, err
	}
	report, err := checkedReleaseReport(out, artifactDigest, trustDigest)
	if err != nil || *report.Valid != (code == 0) {
		return ModelReleaseVerification{}, ErrValidatorUnavailable
	}
	return report, nil
}
