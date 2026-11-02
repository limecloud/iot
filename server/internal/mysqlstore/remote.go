package mysqlstore

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/limecloud/iot/server/internal/control"
)

const remoteColumns = `remote_id,space_id,principal_id,local_space_id,request_digest,request_body,status,local_result,created_at,updated_at`

func scanRemote(row scanner) (control.RemoteCommand, error) {
	var v control.RemoteCommand
	var body, result []byte
	err := row.Scan(&v.ID, &v.SpaceID, &v.PrincipalID, &v.LocalSpaceID, &v.Digest, &body, &v.Status, &result, &v.Created, &v.Updated)
	if err != nil {
		return v, missing(err)
	}
	if err = json.Unmarshal(body, &v.Input); err != nil {
		return v, err
	}
	v.Result = result
	return v, nil
}

func (s *Store) ReserveRemote(ctx context.Context, v control.RemoteCommand) (control.RemoteCommand, bool, error) {
	tx, err := begin(ctx, s.DB)
	if err != nil {
		return v, false, err
	}
	defer tx.Rollback()
	if err = ownsTx(ctx, tx, v.PrincipalID, v.SpaceID); err != nil {
		return v, false, err
	}
	old, err := scanRemote(tx.QueryRowContext(ctx, `SELECT `+remoteColumns+` FROM control_remote_commands WHERE space_id=? AND principal_id=? AND request_key=? FOR UPDATE`, v.SpaceID, v.PrincipalID, v.Input.Key))
	if err == nil {
		if old.Digest != v.Digest {
			return old, false, control.ErrConflict
		}
		return old, false, tx.Commit()
	}
	if !errors.Is(err, control.ErrMissing) {
		return v, false, err
	}
	binding, err := scanGateway(tx.QueryRowContext(ctx, `SELECT `+gatewayColumns+` FROM control_gateways WHERE gateway_id=? AND revision=? AND space_id=? AND principal_id=? AND active=TRUE FOR UPDATE`, v.Input.GatewayID, v.Input.Revision, v.SpaceID, v.PrincipalID))
	if err != nil {
		return v, false, err
	}
	if !slices.Contains(binding.Scopes, "commands.write") {
		return v, false, control.ErrForbidden
	}
	if !v.Input.Expires.After(time.Now()) || v.Input.Expires.After(time.Now().Add(30*time.Second)) {
		return v, false, control.ErrConflict
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM control_remote_commands WHERE space_id=?`, v.SpaceID).Scan(&count); err != nil {
		return v, false, err
	}
	if count >= 1024 {
		return v, false, control.ErrCapacity
	}
	v.LocalSpaceID = binding.LocalSpaceID
	v.Status = "unknown"
	v.Created = time.Now().UTC()
	v.Updated = v.Created
	raw, err := json.Marshal(v.Input)
	if err != nil {
		return v, false, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO control_remote_commands (remote_id,space_id,principal_id,gateway_id,binding_revision,local_space_id,request_key,request_digest,request_body,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, v.ID, v.SpaceID, v.PrincipalID, v.Input.GatewayID, v.Input.Revision, v.LocalSpaceID, v.Input.Key, v.Digest, raw, v.Status, v.Created, v.Updated)
	if err != nil {
		return v, false, err
	}
	if err = audit(ctx, tx, v.PrincipalID, v.SpaceID, "remote.intent", v.ID); err != nil {
		return v, false, err
	}
	return v, true, tx.Commit()
}

func (s *Store) RemoteCommand(ctx context.Context, actor, space, id string, byKey bool) (control.RemoteCommand, error) {
	column := "remote_id"
	if byKey {
		column = "request_key"
	}
	return scanRemote(s.DB.QueryRowContext(ctx, `SELECT `+remoteColumns+` FROM control_remote_commands WHERE space_id=? AND principal_id=? AND `+column+`=? AND EXISTS (SELECT 1 FROM control_memberships m WHERE m.space_id=control_remote_commands.space_id AND m.principal_id=? AND m.role='owner' AND m.active=TRUE)`, space, actor, id, actor))
}

func (s *Store) SaveRemoteResult(ctx context.Context, expected control.RemoteCommand, status string, result json.RawMessage) (control.RemoteCommand, error) {
	switch status {
	case "accepted", "dispatched", "unknown", "confirmed", "failed", "rejected", "expired":
	default:
		return expected, control.ErrConflict
	}
	tx, err := begin(ctx, s.DB)
	if err != nil {
		return expected, err
	}
	defer tx.Rollback()
	if err = ownsTx(ctx, tx, expected.PrincipalID, expected.SpaceID); err != nil {
		return expected, err
	}
	// 与撤销共享空间锁。迟到结果不能跨revision或撤销恢复权限。
	binding, err := scanGateway(tx.QueryRowContext(ctx, `SELECT `+gatewayColumns+` FROM control_gateways WHERE gateway_id=? AND revision=? AND active=TRUE FOR UPDATE`, expected.Input.GatewayID, expected.Input.Revision))
	if err != nil {
		return expected, err
	}
	if binding.PrincipalID != expected.PrincipalID || binding.SpaceID != expected.SpaceID || !slices.Contains(binding.Scopes, "commands.write") {
		return expected, control.ErrForbidden
	}
	current, err := scanRemote(tx.QueryRowContext(ctx, `SELECT `+remoteColumns+` FROM control_remote_commands WHERE remote_id=? FOR UPDATE`, expected.ID))
	if err != nil {
		return current, err
	}
	if current.SpaceID != expected.SpaceID || current.PrincipalID != expected.PrincipalID || current.Input.Revision != expected.Input.Revision || current.Digest != expected.Digest {
		return current, control.ErrConflict
	}
	switch current.Status {
	case "confirmed", "failed", "rejected", "expired":
		return current, nil
	case "dispatched":
		if status == "accepted" {
			return current, nil
		}
	}
	// unknown可能已执行；旧accepted/dispatched回执不能降低已经观察到的unknown。
	if current.Status == "unknown" && len(current.Result) > 0 && (status == "accepted" || status == "dispatched") {
		return current, nil
	}
	_, err = tx.ExecContext(ctx, `UPDATE control_remote_commands SET status=?,local_result=?,updated_at=UTC_TIMESTAMP(6) WHERE remote_id=?`, status, []byte(result), current.ID)
	if err != nil {
		return current, err
	}
	if err = audit(ctx, tx, current.PrincipalID, current.SpaceID, "remote.result", current.ID); err != nil {
		return current, err
	}
	if err = tx.Commit(); err != nil {
		return current, err
	}
	return s.RemoteCommand(ctx, current.PrincipalID, current.SpaceID, current.ID, false)
}

var _ control.RemoteCommands = (*Store)(nil)
