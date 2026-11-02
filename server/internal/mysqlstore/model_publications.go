package mysqlstore

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/limecloud/iot/server/internal/control"
)

func scanPublication(row scanner) (control.ModelPublication, error) {
	var value control.ModelPublication
	var raw []byte
	if err := row.Scan(&raw); err != nil {
		return value, missing(err)
	}
	err := json.Unmarshal(raw, &value)
	return value, err
}
func scanPublishOperation(row scanner) (control.ModelPublishOperation, error) {
	var value control.ModelPublishOperation
	var raw []byte
	if err := row.Scan(&raw); err != nil {
		return value, missing(err)
	}
	err := json.Unmarshal(raw, &value)
	return value, err
}

const publicationHead = `SELECT publication_body FROM control_model_publications WHERE principal_id=? AND product_id=? ORDER BY publication_order DESC LIMIT 1`

func (s *Store) CommitModelPublication(ctx context.Context, value control.ModelPublishOperation) (control.ModelPublishOperation, error) {
	tx, err := begin(ctx, s.DB)
	if err != nil {
		return value, err
	}
	defer tx.Rollback()
	var actor string
	// 与草稿共用主体锁，防止校验期间的编辑或另一发布改变候选基线。
	if err = tx.QueryRowContext(ctx, `SELECT principal_id FROM control_principals WHERE principal_id=? FOR UPDATE`, value.PrincipalID).Scan(&actor); err != nil {
		return value, missing(err)
	}
	old, err := scanPublishOperation(tx.QueryRowContext(ctx, `SELECT operation_body FROM control_model_publish_operations WHERE principal_id=? AND request_key=?`, actor, value.Input.Key))
	if err == nil {
		if old.Digest != value.Digest {
			return old, control.ErrConflict
		}
		return old, tx.Commit()
	}
	if !errors.Is(err, control.ErrMissing) {
		return value, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM control_model_publish_operations WHERE principal_id=?`, actor).Scan(&count); err != nil {
		return value, err
	}
	if count >= 1024 {
		return value, control.ErrReleaseCapacity
	}
	product, err := scanProduct(tx.QueryRowContext(ctx, `SELECT `+productColumns+` FROM control_products WHERE principal_id=? AND product_id=? FOR UPDATE`, actor, value.ProductID))
	if err != nil {
		return value, err
	}
	head, err := scanPublication(tx.QueryRowContext(ctx, publicationHead, actor, value.ProductID))
	if err != nil && !errors.Is(err, control.ErrMissing) {
		return value, err
	}
	var headID *string
	if err == nil {
		id := head.Artifact.Statement.ReleaseID
		headID = &id
	}
	draftChanged := product.Revision != value.Input.ExpectedRevision || product.Revision != value.SourceRevision || product.DocumentDigest != value.SourceDigest
	headChanged := (headID == nil) != (value.Input.ExpectedReleaseID == nil) || headID != nil && *headID != *value.Input.ExpectedReleaseID
	// 先清除基于旧输入的报告和候选签名，再保存耐久的冲突决定。
	if draftChanged || headChanged {
		value.Validation, value.Compatibility = nil, nil
		reason := "draft_revision_conflict"
		if !draftChanged {
			reason = "release_baseline_conflict"
		}
		value.Reject("conflict", reason)
	}
	value.SourceRevision, value.SourceDigest, value.HeadReleaseID = product.Revision, product.DocumentDigest, headID
	value.Created = time.Now().UTC().Truncate(time.Microsecond)
	if value.Status == "published" {
		if value.Release == nil || value.Validation == nil || value.Validation.Valid == nil || !*value.Validation.Valid {
			return value, control.ErrConflict
		}
		statement := value.Release.Artifact.Statement
		if statement.ProductID != product.ID || statement.SourceRevision != product.Revision || statement.SourceDocumentDigest != product.DocumentDigest || value.Validation.DocumentDigest == nil || *value.Validation.DocumentDigest != product.DocumentDigest {
			return value, control.ErrConflict
		}
		var model struct {
			ID      string `json:"model_id"`
			Version string `json:"model_version"`
		}
		if json.Unmarshal(statement.Model, &model) != nil {
			return value, control.ErrConflict
		}
		var owner string
		err = tx.QueryRowContext(ctx, `SELECT product_id FROM control_model_publications WHERE principal_id=? AND model_id=? LIMIT 1`, actor, model.ID).Scan(&owner)
		if err == nil && owner != product.ID {
			value.Reject("rejected", "model_id_already_published")
		} else if err != nil && !errors.Is(missing(err), control.ErrMissing) {
			return value, err
		}
		if value.Status == "published" {
			raw, err := json.Marshal(value.Release)
			if err != nil {
				return value, err
			}
			if _, err = tx.ExecContext(ctx, `INSERT INTO control_model_publications (release_id,principal_id,product_id,model_id,model_version,publication_body) VALUES (?,?,?,?,?,?)`, statement.ReleaseID, actor, product.ID, model.ID, model.Version, raw); err != nil {
				return value, err
			}
		}
	} else if value.Status != "rejected" && value.Status != "conflict" {
		return value, control.ErrConflict
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return value, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO control_model_publish_operations (operation_id,principal_id,product_id,request_key,request_digest,operation_body,created_at) VALUES (?,?,?,?,?,?,?)`, value.ID, actor, product.ID, value.Input.Key, value.Digest, raw, value.Created); err != nil {
		return value, err
	}
	if err = audit(ctx, tx, actor, "", "model.release."+value.Status, product.ID); err != nil {
		return value, err
	}
	return value, tx.Commit()
}
func (s *Store) ModelPublishOperation(ctx context.Context, actor, key string) (control.ModelPublishOperation, error) {
	return scanPublishOperation(s.DB.QueryRowContext(ctx, `SELECT operation_body FROM control_model_publish_operations WHERE principal_id=? AND request_key=?`, actor, key))
}
func (s *Store) ModelPublicationHead(ctx context.Context, actor, product string) (*control.ModelPublication, error) {
	value, err := scanPublication(s.DB.QueryRowContext(ctx, publicationHead, actor, product))
	if errors.Is(err, control.ErrMissing) {
		return nil, nil
	}
	return &value, err
}
func (s *Store) PublicModelPublication(ctx context.Context, id string) (control.ModelPublication, error) {
	return scanPublication(s.DB.QueryRowContext(ctx, `SELECT publication_body FROM control_model_publications WHERE release_id=?`, id))
}
func (s *Store) ModelPublications(ctx context.Context, actor, product, after string) (control.ModelPublicationPage, error) {
	value := control.ModelPublicationPage{Items: []control.ModelPublication{}}
	if _, err := s.Product(ctx, actor, product); err != nil {
		return value, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT publication_body FROM control_model_publications WHERE principal_id=? AND product_id=? AND release_id>? ORDER BY release_id LIMIT 17`, actor, product, after)
	if err != nil {
		return value, err
	}
	defer rows.Close()
	for rows.Next() {
		item, err := scanPublication(rows)
		if err != nil {
			return value, err
		}
		if len(value.Items) == 16 {
			id := value.Items[15].Artifact.Statement.ReleaseID
			value.Next = &id
			break
		}
		value.Items = append(value.Items, item)
	}
	return value, rows.Err()
}

var _ control.ModelPublications = (*Store)(nil)
