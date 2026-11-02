package mysqlstore

import (
	"context"
	"time"

	"github.com/limecloud/iot/server/internal/control"
)

var _ control.NativeAuthorizations = (*Store)(nil)

const nativeColumns = `authorization_id,request_hash,control_origin,platform,code_challenge,code_hash,code_encrypted,status,attempts,parent_hash,principal_id,child_hash,material_encrypted,expires_at,created_at`

func scanNative(row interface{ Scan(...any) error }) (control.NativeAuthorization, error) {
	var v control.NativeAuthorization
	err := row.Scan(&v.ID, &v.KeyHash, &v.Origin, &v.Platform, &v.Challenge, &v.CodeHash, &v.Code, &v.Status, &v.Attempts, &v.ParentHash, &v.PrincipalID, &v.ChildHash, &v.Material, &v.Expires, &v.Created)
	return v, missing(err)
}

func (s *Store) NativeAuthorization(ctx context.Context, id string, byKey bool) (control.NativeAuthorization, error) {
	column := "authorization_id"
	if byKey {
		column = "request_hash"
	}
	return scanNative(s.DB.QueryRowContext(ctx, `SELECT `+nativeColumns+` FROM control_native_authorizations WHERE `+column+`=?`, id))
}
func (s *Store) CreateNativeAuthorization(ctx context.Context, v control.NativeAuthorization) (control.NativeAuthorization, error) {
	tx, err := begin(ctx, s.DB)
	if err != nil {
		return v, err
	}
	defer tx.Rollback()
	var guard int
	if err = tx.QueryRowContext(ctx, `SELECT guard_id FROM control_native_authorization_guard WHERE guard_id=1 FOR UPDATE`).Scan(&guard); err != nil {
		return v, err
	}
	old, err := scanNative(tx.QueryRowContext(ctx, `SELECT `+nativeColumns+` FROM control_native_authorizations WHERE request_hash=? FOR UPDATE`, v.KeyHash))
	if err == nil {
		if old.Origin != v.Origin || old.Challenge != v.Challenge || old.Platform != v.Platform {
			return old, control.ErrConflict
		}
		return old, tx.Commit()
	}
	if err != control.ErrMissing {
		return v, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM control_native_authorizations`).Scan(&count); err != nil {
		return v, err
	}
	if count >= 4096 {
		return v, control.ErrCapacity
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO control_native_authorizations (authorization_id,request_hash,control_origin,platform,code_challenge,code_hash,code_encrypted,status,expires_at,created_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)`, v.ID, v.KeyHash, v.Origin, v.Platform, v.Challenge, v.CodeHash, v.Code, v.Expires, v.Created)
	if err != nil {
		return v, err
	}
	v.Status = "pending"
	return v, tx.Commit()
}
func (s *Store) DecideNativeAuthorization(ctx context.Context, id, origin, codeHash string, parent, child control.Session, material []byte) (control.NativeAuthorization, error) {
	tx, err := begin(ctx, s.DB)
	if err != nil {
		return control.NativeAuthorization{}, err
	}
	defer tx.Rollback()
	v, err := scanNative(tx.QueryRowContext(ctx, `SELECT `+nativeColumns+` FROM control_native_authorizations WHERE authorization_id=? FOR UPDATE`, id))
	if err != nil {
		return v, err
	}
	if v.Origin != origin {
		return v, control.ErrMissing
	}
	if !v.Expires.After(time.Now()) {
		return v, control.ErrNativeExpired
	}
	if v.Status != "pending" {
		if v.ParentHash == parent.Hash && v.PrincipalID == parent.Principal.ID && ((v.Status == "approved" && child.Hash != "") || (v.Status == "denied" && child.Hash == "")) {
			return v, tx.Commit()
		}
		return v, control.ErrConflict
	}
	if v.CodeHash != codeHash {
		_, err = tx.ExecContext(ctx, `UPDATE control_native_authorizations SET attempts=attempts+1,status=IF(attempts>=5,'denied',status) WHERE authorization_id=?`, id)
		if err != nil {
			return v, err
		}
		if err = tx.Commit(); err != nil {
			return v, err
		}
		return v, control.ErrForbidden
	}
	var principal string
	var expiry time.Time
	if err = tx.QueryRowContext(ctx, `SELECT principal_id,expires_at FROM control_sessions WHERE token_hash=? AND audience='console' AND expires_at>UTC_TIMESTAMP(6) FOR UPDATE`, parent.Hash).Scan(&principal, &expiry); err != nil {
		return v, missing(err)
	}
	if principal != parent.Principal.ID || (!child.Expires.IsZero() && child.Expires.After(expiry)) {
		return v, control.ErrForbidden
	}
	status := "denied"
	if child.Hash != "" {
		status = "approved"
		if child.Principal.ID != principal || child.Audience != "console" || !child.Expires.After(time.Now()) || child.Expires.After(time.Now().Add(time.Hour)) || child.External {
			return v, control.ErrForbidden
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO control_sessions (token_hash,audience,principal_id,credential,external_identity,expires_at) VALUES (?,?,?,?,FALSE,?)`, child.Hash, "console", principal, child.Credential, child.Expires)
		if err != nil {
			return v, err
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE control_native_authorizations SET status=?,parent_hash=?,principal_id=?,child_hash=?,material_encrypted=? WHERE authorization_id=?`, status, parent.Hash, principal, child.Hash, material, id)
	if err != nil {
		return v, err
	}
	v.Status = status
	v.ParentHash = parent.Hash
	v.PrincipalID = principal
	v.ChildHash = child.Hash
	v.Material = material
	return v, tx.Commit()
}
func (s *Store) CancelNativeAuthorization(ctx context.Context, key string) (control.NativeAuthorization, error) {
	tx, err := begin(ctx, s.DB)
	if err != nil {
		return control.NativeAuthorization{}, err
	}
	defer tx.Rollback()
	v, err := scanNative(tx.QueryRowContext(ctx, `SELECT `+nativeColumns+` FROM control_native_authorizations WHERE request_hash=? FOR UPDATE`, key))
	if err != nil {
		return v, err
	}
	if v.ChildHash != "" {
		if _, err = tx.ExecContext(ctx, `DELETE FROM control_sessions WHERE token_hash=? AND audience='console'`, v.ChildHash); err != nil {
			return v, err
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE control_native_authorizations SET status='cancelled',material_encrypted=NULL WHERE authorization_id=?`, v.ID)
	if err != nil {
		return v, err
	}
	v.Status = "cancelled"
	v.Material = nil
	return v, tx.Commit()
}
