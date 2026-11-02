package mysqlstore

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/limecloud/iot/server/internal/control"
)

const productColumns = `product_id,principal_id,display_name,revision,document_digest,model_body,created_at,updated_at`

func scanProduct(row scanner) (control.Product, error) {
	var v control.Product
	var raw []byte
	err := row.Scan(&v.ID, &v.PrincipalID, &v.Name, &v.Revision, &v.DocumentDigest, &raw, &v.Created, &v.Updated)
	v.Model = raw
	v.Status = "draft"
	v.Validation = "unvalidated"
	return v, missing(err)
}
func scanProductOperation(row scanner) (control.ProductOperation, error) {
	var v control.ProductOperation
	var raw []byte
	if err := row.Scan(&raw); err != nil {
		return v, missing(err)
	}
	err := json.Unmarshal(raw, &v)
	return v, err
}
func (s *Store) WriteProduct(ctx context.Context, v control.ProductOperation) (control.ProductOperation, error) {
	tx, err := begin(ctx, s.DB)
	if err != nil {
		return v, err
	}
	defer tx.Rollback()
	var actor string
	// 同一发布者的原键、配额与产品修订在同一锁序下决定。
	if err = tx.QueryRowContext(ctx, `SELECT principal_id FROM control_principals WHERE principal_id=? FOR UPDATE`, v.PrincipalID).Scan(&actor); err != nil {
		return v, missing(err)
	}
	old, err := scanProductOperation(tx.QueryRowContext(ctx, `SELECT operation_body FROM control_product_operations WHERE principal_id=? AND request_key=?`, actor, v.Input.Key))
	if err == nil {
		if old.Digest != v.Digest {
			return old, control.ErrConflict
		}
		return old, tx.Commit()
	}
	if !errors.Is(err, control.ErrMissing) {
		return v, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM control_product_operations WHERE principal_id=?`, actor).Scan(&count); err != nil {
		return v, err
	}
	if count >= 1024 {
		return v, control.ErrProductCapacity
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	v.Created = now
	v.Status = "saved"
	digest, err := control.CanonicalDigest(v.Input.Model)
	if err != nil {
		return v, err
	}
	if v.Kind == "products.create" {
		if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM control_products WHERE principal_id=?`, actor).Scan(&count); err != nil {
			return v, err
		}
		if count >= 128 {
			return v, control.ErrProductCapacity
		}
		v.ProductID = "product-" + control.Random()
		v.Product = control.Product{ID: v.ProductID, PrincipalID: actor, Name: v.Input.Name, Revision: "prodrev-" + control.Random(), DocumentDigest: "sha256:" + digest, Model: v.Input.Model, Status: "draft", Validation: "unvalidated", Created: now, Updated: now}
		_, err = tx.ExecContext(ctx, `INSERT INTO control_products (product_id,principal_id,display_name,revision,document_digest,model_body,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`, v.Product.ID, actor, v.Product.Name, v.Product.Revision, v.Product.DocumentDigest, []byte(v.Product.Model), now, now)
	} else if v.Kind == "products.save" {
		v.Product, err = scanProduct(tx.QueryRowContext(ctx, `SELECT `+productColumns+` FROM control_products WHERE product_id=? AND principal_id=? FOR UPDATE`, v.ProductID, actor))
		if err != nil {
			return v, err
		}
		if v.Product.Revision != v.Input.ExpectedRevision {
			v.Status = "conflict"
		} else {
			v.Product.Name = v.Input.Name
			v.Product.Model = v.Input.Model
			v.Product.DocumentDigest = "sha256:" + digest
			v.Product.Revision = "prodrev-" + control.Random()
			v.Product.Updated = now
			_, err = tx.ExecContext(ctx, `UPDATE control_products SET display_name=?,revision=?,document_digest=?,model_body=?,updated_at=? WHERE product_id=? AND principal_id=?`, v.Product.Name, v.Product.Revision, v.Product.DocumentDigest, []byte(v.Product.Model), now, v.ProductID, actor)
		}
	} else {
		return v, control.ErrConflict
	}
	if err != nil {
		return v, err
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return v, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO control_product_operations (operation_id,principal_id,product_id,request_key,request_digest,operation_body,created_at) VALUES (?,?,?,?,?,?,?)`, v.ID, actor, v.ProductID, v.Input.Key, v.Digest, raw, now)
	if err != nil {
		return v, err
	}
	if err = audit(ctx, tx, actor, "", "product.draft."+v.Status, v.ProductID); err != nil {
		return v, err
	}
	return v, tx.Commit()
}
func (s *Store) Product(ctx context.Context, actor, id string) (control.Product, error) {
	return scanProduct(s.DB.QueryRowContext(ctx, `SELECT `+productColumns+` FROM control_products WHERE principal_id=? AND product_id=?`, actor, id))
}
func (s *Store) ProductOperation(ctx context.Context, actor, key string) (control.ProductOperation, error) {
	return scanProductOperation(s.DB.QueryRowContext(ctx, `SELECT operation_body FROM control_product_operations WHERE principal_id=? AND request_key=?`, actor, key))
}
func (s *Store) Products(ctx context.Context, actor, after string) (control.ProductPage, error) {
	v := control.ProductPage{Items: []control.Product{}}
	rows, err := s.DB.QueryContext(ctx, `SELECT `+productColumns+` FROM control_products WHERE principal_id=? AND product_id>? ORDER BY product_id LIMIT 17`, actor, after)
	if err != nil {
		return v, err
	}
	defer rows.Close()
	for rows.Next() {
		item, err := scanProduct(rows)
		if err != nil {
			return v, err
		}
		if len(v.Items) == 16 {
			id := v.Items[15].ID
			v.Next = &id
			break
		}
		v.Items = append(v.Items, item)
	}
	return v, rows.Err()
}

var _ control.ProductDrafts = (*Store)(nil)
