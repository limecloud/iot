package mysqlstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-sql-driver/mysql"
	"github.com/limecloud/iot/server/internal/control"
)

type Store struct{ DB *sql.DB }

var _ control.Sessions = (*Store)(nil)
var _ control.Registry = (*Store)(nil)

func missing(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return control.ErrMissing
	}
	return err
}
func (s *Store) Principal(ctx context.Context, id control.Identity) (control.Principal, error) {
	if id.Issuer == "" || len(id.Issuer) > 512 || id.Subject == "" || len(id.Subject) > 255 {
		return control.Principal{}, control.ErrIdentity
	}
	name := strings.TrimSpace(id.Name)
	if name == "" {
		name = "LimeIoT"
	}
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) > 160 {
		return control.Principal{}, control.ErrIdentity
	}
	_, err := s.DB.ExecContext(ctx, `INSERT INTO control_principals (principal_id,issuer,subject,display_name) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE display_name=VALUES(display_name)`, "p-"+control.Random(), id.Issuer, id.Subject, name)
	if err != nil {
		return control.Principal{}, err
	}
	var p control.Principal
	err = s.DB.QueryRowContext(ctx, `SELECT principal_id,issuer,subject,display_name FROM control_principals WHERE issuer=? AND subject=?`, id.Issuer, id.Subject).Scan(&p.ID, &p.Issuer, &p.Subject, &p.Name)
	return p, err
}
func (s *Store) SaveSession(ctx context.Context, v control.Session) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO control_sessions (token_hash,audience,principal_id,credential,external_identity,expires_at) VALUES (?,?,?,?,?,?)`, v.Hash, v.Audience, v.Principal.ID, v.Credential, v.External, v.Expires.UTC())
	return err
}
func (s *Store) Session(ctx context.Context, hash, audience string) (control.Session, error) {
	v := control.Session{Hash: hash, Audience: audience}
	err := s.DB.QueryRowContext(ctx, `SELECT p.principal_id,p.issuer,p.subject,p.display_name,s.credential,s.external_identity,s.expires_at FROM control_sessions s JOIN control_principals p USING(principal_id) WHERE s.token_hash=? AND s.audience=? AND s.expires_at>UTC_TIMESTAMP(6)`, hash, audience).Scan(&v.Principal.ID, &v.Principal.Issuer, &v.Principal.Subject, &v.Principal.Name, &v.Credential, &v.External, &v.Expires)
	return v, missing(err)
}
func (s *Store) RevokeSession(ctx context.Context, hash, audience string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM control_sessions WHERE token_hash=? AND audience=?`, hash, audience)
	return err
}
func (s *Store) SaveFlow(ctx context.Context, v control.Flow) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO control_login_flows (flow_hash,state_hash,audience,nonce,verifier,expires_at) VALUES (?,?,?,?,?,?)`, v.Hash, v.StateHash, v.Audience, v.Nonce, v.Verifier, v.Expires.UTC())
	return err
}
func (s *Store) TakeFlow(ctx context.Context, hash, state, audience string) (control.Flow, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return control.Flow{}, err
	}
	defer tx.Rollback()
	v := control.Flow{Hash: hash, StateHash: state, Audience: audience}
	err = tx.QueryRowContext(ctx, `SELECT nonce,verifier,expires_at FROM control_login_flows WHERE flow_hash=? AND state_hash=? AND audience=? AND expires_at>UTC_TIMESTAMP(6) FOR UPDATE`, hash, state, audience).Scan(&v.Nonce, &v.Verifier, &v.Expires)
	if err != nil {
		return v, missing(err)
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM control_login_flows WHERE flow_hash=?`, hash); err != nil {
		return v, err
	}
	return v, tx.Commit()
}
func (s *Store) Sweep(ctx context.Context) error {
	for _, table := range []string{"control_sessions", "control_login_flows"} {
		if _, err := s.DB.ExecContext(ctx, `DELETE FROM `+table+` WHERE expires_at<=UTC_TIMESTAMP(6) LIMIT 1000`); err != nil {
			return err
		}
	}
	return nil
}
func begin(ctx context.Context, db *sql.DB) (*sql.Tx, error) {
	return db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
}
func ownsTx(ctx context.Context, tx *sql.Tx, actor, space string) error {
	var id string
	// 空间行串行化配对、绑定和撤销；权限在同一事务内再次核对。
	if err := tx.QueryRowContext(ctx, `SELECT space_id FROM control_spaces WHERE space_id=? FOR UPDATE`, space).Scan(&id); err != nil {
		return missing(err)
	}
	if err := tx.QueryRowContext(ctx, `SELECT principal_id FROM control_memberships WHERE space_id=? AND principal_id=? AND role='owner' AND active=TRUE FOR UPDATE`, space, actor).Scan(&id); err != nil {
		return missing(err)
	}
	return nil
}
func audit(ctx context.Context, tx *sql.Tx, actor, space, action, resource string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO control_audit (actor_id,space_id,action,resource_id,created_at) VALUES (?,?,?,?,UTC_TIMESTAMP(6))`, actor, space, action, resource)
	return err
}
func (s *Store) CreateSpace(ctx context.Context, actor, key, name, digest string) (control.Space, error) {
	tx, err := begin(ctx, s.DB)
	if err != nil {
		return control.Space{}, err
	}
	defer tx.Rollback()
	var id string
	if err = tx.QueryRowContext(ctx, `SELECT principal_id FROM control_principals WHERE principal_id=? FOR UPDATE`, actor).Scan(&id); err != nil {
		return control.Space{}, missing(err)
	}
	var v control.Space
	var original string
	err = tx.QueryRowContext(ctx, `SELECT space_id,display_name,created_at,request_digest FROM control_spaces WHERE created_by=? AND request_key=?`, actor, key).Scan(&v.ID, &v.Name, &v.Created, &original)
	if err == nil {
		if original != digest {
			return v, control.ErrConflict
		}
		return v, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return v, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM control_spaces WHERE created_by=?`, actor).Scan(&count); err != nil {
		return v, err
	}
	if count >= 16 {
		return v, control.ErrConflict
	}
	v = control.Space{ID: "sp-" + control.Random(), Name: name, Created: time.Now().UTC()}
	if _, err = tx.ExecContext(ctx, `INSERT INTO control_spaces (space_id,display_name,created_by,request_key,request_digest,created_at) VALUES (?,?,?,?,?,?)`, v.ID, name, actor, key, digest, v.Created); err != nil {
		return v, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO control_memberships (space_id,principal_id,role,active) VALUES (?,?,'owner',TRUE)`, v.ID, actor); err != nil {
		return v, err
	}
	if err = audit(ctx, tx, actor, v.ID, "space.created", v.ID); err != nil {
		return v, err
	}
	return v, tx.Commit()
}
func (s *Store) Spaces(ctx context.Context, actor string) ([]control.Space, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT s.space_id,s.display_name,s.created_at FROM control_spaces s JOIN control_memberships m USING(space_id) WHERE m.principal_id=? AND m.active=TRUE ORDER BY s.created_at,s.space_id LIMIT 16`, actor)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []control.Space{}
	for rows.Next() {
		var v control.Space
		if err = rows.Scan(&v.ID, &v.Name, &v.Created); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) Owns(ctx context.Context, actor, space string) (bool, error) {
	var count int
	err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM control_memberships WHERE space_id=? AND principal_id=? AND role='owner' AND active=TRUE`, space, actor).Scan(&count)
	return count == 1, err
}

type scanner interface{ Scan(...any) error }

const pairingColumns = `q.pairing_id,q.space_id,p.principal_id,p.issuer,p.subject,p.display_name,q.challenge,q.scopes,q.expires_at,q.claimed,q.cancelled,q.code_encrypted,q.code_hash,q.request_key,q.request_digest`

func scanPair(row scanner) (control.Pairing, error) {
	var v control.Pairing
	var scopes []byte
	err := row.Scan(&v.ID, &v.SpaceID, &v.Principal.ID, &v.Principal.Issuer, &v.Principal.Subject, &v.Principal.Name, &v.Challenge, &scopes, &v.Expires, &v.Claimed, &v.Cancelled, &v.Code, &v.CodeHash, &v.RequestKey, &v.Digest)
	if err == nil {
		err = json.Unmarshal(scopes, &v.Scopes)
	}
	return v, missing(err)
}
func (s *Store) SavePairing(ctx context.Context, v control.Pairing) (control.Pairing, error) {
	tx, err := begin(ctx, s.DB)
	if err != nil {
		return v, err
	}
	defer tx.Rollback()
	if err = ownsTx(ctx, tx, v.Principal.ID, v.SpaceID); err != nil {
		return v, err
	}
	old, err := scanPair(tx.QueryRowContext(ctx, `SELECT `+pairingColumns+` FROM control_pairings q JOIN control_principals p USING(principal_id) WHERE q.space_id=? AND q.principal_id=? AND q.request_key=?`, v.SpaceID, v.Principal.ID, v.RequestKey))
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
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM control_gateways WHERE space_id=? AND active=TRUE`, v.SpaceID).Scan(&count); err != nil {
		return v, err
	}
	if count != 0 {
		return v, control.ErrAlreadyBound
	}
	// 有界保留原操作记录；失效配对不会被同键请求悄悄重新开启。
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM control_pairings WHERE space_id=?`, v.SpaceID).Scan(&count); err != nil {
		return v, err
	}
	if count >= 1024 {
		return v, control.ErrConflict
	}
	if _, err = tx.ExecContext(ctx, `UPDATE control_pairings SET cancelled=TRUE WHERE space_id=? AND claimed=FALSE AND cancelled=FALSE`, v.SpaceID); err != nil {
		return v, err
	}
	scopes, err := json.Marshal(v.Scopes)
	if err != nil {
		return v, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO control_pairings (pairing_id,space_id,principal_id,request_key,request_digest,challenge,scopes,code_hash,code_encrypted,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, v.ID, v.SpaceID, v.Principal.ID, v.RequestKey, v.Digest, v.Challenge, scopes, v.CodeHash, v.Code, v.Expires.UTC()); err != nil {
		return v, err
	}
	if err = audit(ctx, tx, v.Principal.ID, v.SpaceID, "pairing.created", v.ID); err != nil {
		return v, err
	}
	return v, tx.Commit()
}
func (s *Store) Pairing(ctx context.Context, id, hash string) (control.Pairing, error) {
	return scanPair(s.DB.QueryRowContext(ctx, `SELECT `+pairingColumns+` FROM control_pairings q JOIN control_principals p USING(principal_id) WHERE q.pairing_id=? AND q.code_hash=?`, id, hash))
}

const gatewayColumns = `gateway_id,space_id,local_space_id,principal_id,public_key,scopes,revision,active,created_at`

func scanGateway(row scanner) (control.Gateway, error) {
	var v control.Gateway
	var scopes []byte
	err := row.Scan(&v.ID, &v.SpaceID, &v.LocalSpaceID, &v.PrincipalID, &v.PublicKey, &scopes, &v.Revision, &v.Active, &v.Created)
	if err == nil {
		err = json.Unmarshal(scopes, &v.Scopes)
	}
	return v, missing(err)
}
func (s *Store) Claim(ctx context.Context, expected control.Pairing, claim control.Claim) (control.Gateway, error) {
	tx, err := begin(ctx, s.DB)
	if err != nil {
		return control.Gateway{}, err
	}
	defer tx.Rollback()
	if err = ownsTx(ctx, tx, expected.Principal.ID, expected.SpaceID); err != nil {
		return control.Gateway{}, err
	}
	q, err := scanPair(tx.QueryRowContext(ctx, `SELECT `+pairingColumns+` FROM control_pairings q JOIN control_principals p USING(principal_id) WHERE q.pairing_id=? FOR UPDATE`, expected.ID))
	if err != nil {
		return control.Gateway{}, err
	}
	if q.CodeHash != expected.CodeHash || q.SpaceID != expected.SpaceID || q.Principal.ID != expected.Principal.ID || q.Cancelled {
		return control.Gateway{}, control.ErrMissing
	}
	if q.Claimed {
		v, err := scanGateway(tx.QueryRowContext(ctx, `SELECT `+gatewayColumns+` FROM control_gateways WHERE pairing_id=?`, q.ID))
		if err != nil {
			return v, err
		}
		if !v.Active || v.ID != claim.GatewayID || v.PublicKey != claim.PublicKey || v.LocalSpaceID != claim.LocalSpaceID {
			return v, control.ErrConflict
		}
		return v, tx.Commit()
	}
	if !q.Expires.After(time.Now()) {
		return control.Gateway{}, control.ErrMissing
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM control_gateways WHERE active=TRUE AND (space_id=? OR gateway_id=?)`, q.SpaceID, claim.GatewayID).Scan(&count); err != nil {
		return control.Gateway{}, err
	}
	if count != 0 {
		return control.Gateway{}, control.ErrAlreadyBound
	}
	v := control.Gateway{ID: claim.GatewayID, SpaceID: q.SpaceID, LocalSpaceID: claim.LocalSpaceID, PrincipalID: q.Principal.ID, PublicKey: claim.PublicKey, Scopes: q.Scopes, Revision: "rev-" + control.Random(), Active: true, Created: time.Now().UTC()}
	scopes, _ := json.Marshal(v.Scopes)
	if _, err = tx.ExecContext(ctx, `INSERT INTO control_gateways (gateway_id,space_id,local_space_id,principal_id,public_key,pairing_id,scopes,revision,active,created_at) VALUES (?,?,?,?,?,?,?,?,TRUE,?)`, v.ID, v.SpaceID, v.LocalSpaceID, v.PrincipalID, v.PublicKey, q.ID, scopes, v.Revision, v.Created); err != nil {
		var duplicate *mysql.MySQLError
		if errors.As(err, &duplicate) && duplicate.Number == 1062 {
			return v, control.ErrAlreadyBound
		}
		return v, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE control_pairings SET claimed=TRUE WHERE pairing_id=?`, q.ID); err != nil {
		return v, err
	}
	if err = audit(ctx, tx, v.PrincipalID, v.SpaceID, "gateway.paired", v.ID); err != nil {
		return v, err
	}
	return v, tx.Commit()
}
func (s *Store) Gateways(ctx context.Context, actor, space string) ([]control.Gateway, error) {
	owns, err := s.Owns(ctx, actor, space)
	if err != nil {
		return nil, err
	}
	if !owns {
		return nil, control.ErrMissing
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT `+gatewayColumns+` FROM control_gateways WHERE space_id=? ORDER BY created_at DESC,revision DESC LIMIT 1024`, space)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []control.Gateway{}
	for rows.Next() {
		v, err := scanGateway(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *Store) Binding(ctx context.Context, p control.Pairing, c control.Claim) (control.Gateway, error) {
	v, err := scanGateway(s.DB.QueryRowContext(ctx, `SELECT `+gatewayColumns+` FROM control_gateways WHERE pairing_id=? AND EXISTS (SELECT 1 FROM control_memberships m WHERE m.space_id=control_gateways.space_id AND m.principal_id=? AND m.role='owner' AND m.active=TRUE)`, p.ID, p.Principal.ID))
	if err != nil {
		return v, err
	}
	if v.ID != c.GatewayID || v.LocalSpaceID != c.LocalSpaceID || v.PublicKey != c.PublicKey || v.SpaceID != p.SpaceID || v.PrincipalID != p.Principal.ID {
		return v, control.ErrConflict
	}
	return v, nil
}
func (s *Store) MachineBinding(ctx context.Context, id, revision string) (control.Gateway, error) {
	return scanGateway(s.DB.QueryRowContext(ctx, `SELECT `+gatewayColumns+` FROM control_gateways WHERE gateway_id=? AND revision=? AND active=TRUE AND EXISTS (SELECT 1 FROM control_memberships m WHERE m.space_id=control_gateways.space_id AND m.principal_id=control_gateways.principal_id AND m.role='owner' AND m.active=TRUE)`, id, revision))
}
func (s *Store) RevokeGateway(ctx context.Context, actor, space, id, revision string) error {
	tx, err := begin(ctx, s.DB)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = ownsTx(ctx, tx, actor, space); err != nil {
		return err
	}
	var active bool
	if err = tx.QueryRowContext(ctx, `SELECT active FROM control_gateways WHERE gateway_id=? AND space_id=? AND revision=? FOR UPDATE`, id, space, revision).Scan(&active); err != nil {
		return missing(err)
	}
	if !active {
		return tx.Commit()
	}
	if _, err = tx.ExecContext(ctx, `UPDATE control_gateways SET active=FALSE WHERE revision=?`, revision); err != nil {
		return err
	}
	if err = audit(ctx, tx, actor, space, "gateway.revoked", id); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) GatewaySummaries(ctx context.Context) ([]control.GatewaySummary, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT gateway_id,active,created_at FROM control_gateways ORDER BY created_at DESC,revision DESC LIMIT 1000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []control.GatewaySummary{}
	for rows.Next() {
		var v control.GatewaySummary
		if err = rows.Scan(&v.ID, &v.Active, &v.Created); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
