package control

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var ErrReleaseCapacity = errors.New("release_capacity_reached")

type ModelPublication struct {
	Artifact ModelReleaseArtifact `json:"artifact"`
	Trust    ModelReleaseTrust    `json:"trust"`
}
type ModelPublicationPage struct {
	Items []ModelPublication `json:"items"`
	Next  *string            `json:"next"`
}
type ModelPublishInput struct {
	Key               string  `json:"request_key"`
	ExpectedRevision  string  `json:"expected_revision"`
	ExpectedReleaseID *string `json:"expected_release_id"`
	Visibility        string  `json:"visibility"`
}
type ModelPublishOperation struct {
	ID             string            `json:"operation_id"`
	PrincipalID    string            `json:"principal_id"`
	ProductID      string            `json:"product_id"`
	Digest         string            `json:"request_digest"`
	Input          ModelPublishInput `json:"request"`
	Status         string            `json:"status"`
	Reason         *string           `json:"reason"`
	SourceRevision string            `json:"source_revision"`
	SourceDigest   string            `json:"source_document_digest"`
	HeadReleaseID  *string           `json:"head_release_id"`
	Validation     *ModelReport      `json:"validation"`
	Compatibility  *ModelComparison  `json:"compatibility"`
	Release        *ModelPublication `json:"release"`
	Created        time.Time         `json:"created_at"`
}

// ModelPublications 隔离不可变发布、原决定与私有草稿；提交时必须原子复核两种预期修订。
type ModelPublications interface {
	CommitModelPublication(context.Context, ModelPublishOperation) (ModelPublishOperation, error)
	ModelPublishOperation(context.Context, string, string) (ModelPublishOperation, error)
	ModelPublicationHead(context.Context, string, string) (*ModelPublication, error)
	ModelPublications(context.Context, string, string, string) (ModelPublicationPage, error)
	PublicModelPublication(context.Context, string) (ModelPublication, error)
}

func publicationID(value *ModelPublication) *string {
	if value == nil {
		return nil
	}
	id := value.Artifact.Statement.ReleaseID
	return &id
}
func sameReleaseID(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}
func (v *ModelPublishOperation) Reject(status, reason string) {
	v.Status, v.Reason, v.Release = status, &reason, nil
}

// preparePublication 只生成候选决定；数据库再次核对草稿和发布头后才可对外称为发布。
func (s *Server) preparePublication(ctx context.Context, operation ModelPublishOperation, product Product, head *ModelPublication) (ModelPublishOperation, error) {
	operation.SourceRevision, operation.SourceDigest = product.Revision, product.DocumentDigest
	operation.HeadReleaseID = publicationID(head)
	if product.Revision != operation.Input.ExpectedRevision {
		operation.Reject("conflict", "draft_revision_conflict")
		return operation, nil
	}
	if !sameReleaseID(operation.HeadReleaseID, operation.Input.ExpectedReleaseID) {
		operation.Reject("conflict", "release_baseline_conflict")
		return operation, nil
	}
	if s.releaseSigner == nil {
		return operation, ErrReleaseSigner
	}
	validation, err := s.modelValidator.Validate(ctx, product.Model)
	if err != nil {
		return operation, err
	}
	operation.Validation = &validation
	if !*validation.Valid {
		operation.Reject("rejected", "invalid_release_model")
		return operation, nil
	}
	publisher, err := ModelPublisherFor(s.cfg.Origin, operation.PrincipalID)
	if err != nil {
		return operation, err
	}
	var identity struct {
		ID      string `json:"model_id"`
		Version string `json:"model_version"`
	}
	if json.Unmarshal(validation.NormalizedModel, &identity) != nil {
		return operation, ErrValidatorUnavailable
	}
	if !strings.HasPrefix(identity.ID, "urn:"+publisher.Namespace+":") {
		operation.Reject("rejected", "release_model_namespace_mismatch")
		return operation, nil
	}
	var baseline *ModelReleaseBaseline
	if head != nil {
		comparison, err := s.modelValidator.Compare(ctx, head.Artifact.Statement.Model, product.Model)
		if err != nil {
			return operation, err
		}
		operation.Compatibility = &comparison
		if comparison.Compatible == nil || !*comparison.Compatible {
			operation.Reject("rejected", "incompatible_release_model")
			return operation, nil
		}
		var old struct {
			Version string `json:"model_version"`
		}
		if json.Unmarshal(head.Artifact.Statement.Model, &old) != nil {
			return operation, ErrValidatorUnavailable
		}
		baseline = &ModelReleaseBaseline{ReleaseID: head.Artifact.Statement.ReleaseID, ModelRevision: head.Artifact.Statement.ModelRevision, ModelVersion: old.Version}
	}
	trust, err := s.releaseSigner.Trust(publisher)
	if err != nil {
		return operation, err
	}
	artifact, err := s.releaseSigner.Sign(ModelReleaseStatement{
		Issuer: s.cfg.Origin, PublisherID: publisher.ID, Namespace: publisher.Namespace,
		ProductID: product.ID, ReleaseID: "release-" + Random(), SourceRevision: product.Revision,
		SourceDocumentDigest: product.DocumentDigest, Visibility: "public", Validator: validation.Validator,
		CompatibilityChecker: "limeiot.model-compatibility/1.1.0", ModelRevision: *validation.ModelRevision,
		Model: validation.NormalizedModel, Baseline: baseline, PublishedAt: time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		return operation, err
	}
	artifactRaw, err := json.Marshal(artifact)
	if err != nil {
		return operation, ErrReleaseSigner
	}
	trustRaw, err := json.Marshal(trust)
	if err != nil {
		return operation, ErrReleaseSigner
	}
	checked, err := s.modelValidator.VerifyRelease(ctx, artifactRaw, trustRaw)
	if err != nil || checked.Valid == nil || !*checked.Valid {
		return operation, ErrValidatorUnavailable
	}
	operation.Status = "published"
	operation.Release = &ModelPublication{Artifact: artifact, Trust: trust}
	return operation, nil
}
