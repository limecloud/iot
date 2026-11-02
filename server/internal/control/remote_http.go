package control

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/gin-gonic/gin"
)

func (s *Server) remoteBinding(ctx context.Context, actor, space, gateway, revision, scope string) (Gateway, error) {
	bindings, err := s.registry.Gateways(ctx, actor, space)
	if err != nil {
		return Gateway{}, err
	}
	for _, b := range bindings {
		if b.Active && (gateway == "" || b.ID == gateway) && (revision == "" || b.Revision == revision) && b.PrincipalID == actor {
			current, err := s.machines.MachineBinding(ctx, b.ID, b.Revision)
			if err != nil {
				return Gateway{}, err
			}
			if !sameMachineBinding(b, current) || !slices.Contains(current.Scopes, scope) {
				return Gateway{}, ErrForbidden
			}
			return current, nil
		}
	}
	return Gateway{}, ErrMissing
}

func (s *Server) remoteDevices(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	binding, err := s.remoteBinding(c.Request.Context(), session.Principal.ID, c.Param("space"), "", "", "devices.read")
	if err != nil {
		result(c, nil, err)
		return
	}
	raw, err := s.relay.call(c.Request.Context(), binding, "devices.list", gin.H{"after": c.Query("after")})
	result(c, raw, err)
}
func (s *Server) remoteModel(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	if !modelRevision(c.Param("revision")) {
		fail(c, 400, "invalid_request")
		return
	}
	binding, err := s.remoteBinding(c.Request.Context(), session.Principal.ID, c.Param("space"), "", "", "devices.read")
	if err != nil {
		result(c, nil, err)
		return
	}
	raw, err := s.relay.call(c.Request.Context(), binding, "models.get", gin.H{"revision": c.Param("revision")})
	result(c, raw, err)
}
func (s *Server) createRemoteCommand(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	var input RemoteInput
	if !body(c, &input) {
		return
	}
	if !identifier(input.Key) || !identifier(input.GatewayID) || !identifier(input.Revision) || !identifier(input.DeviceID) || !modelRevision(input.ModelRevision) || (input.Operation.Type != "property.set" && input.Operation.Type != "action.invoke") || len(input.Operation.Path) > 129 || input.Operation.Path == "" || len(input.Operation.Value) == 0 || len(input.Operation.Value) > 4096 || !identifier(c.Param("space")) {
		fail(c, 400, "invalid_request")
		return
	}
	input.Expires = input.Expires.UTC()
	digest, err := CanonicalDigest(input)
	if err != nil {
		fail(c, 400, "invalid_request")
		return
	}
	// 恢复优先于当前期限与连接检查。旧原键永远不重新发送create。
	old, err := s.remote.RemoteCommand(c.Request.Context(), session.Principal.ID, c.Param("space"), input.Key, true)
	if err == nil {
		if old.Digest != digest {
			result(c, nil, ErrConflict)
		} else {
			result(c, old, nil)
		}
		return
	}
	if !errors.Is(err, ErrMissing) {
		result(c, nil, err)
		return
	}
	if !input.Expires.After(time.Now()) || input.Expires.After(time.Now().Add(30*time.Second)) {
		fail(c, 400, "invalid_expiry")
		return
	}
	binding, err := s.remoteBinding(c.Request.Context(), session.Principal.ID, c.Param("space"), input.GatewayID, input.Revision, "commands.write")
	if err != nil {
		result(c, nil, err)
		return
	}
	if !s.relay.view(binding).Connected {
		result(c, nil, ErrOffline)
		return
	}
	v, created, err := s.remote.ReserveRemote(c.Request.Context(), RemoteCommand{ID: "remote-" + Random(), SpaceID: binding.SpaceID, PrincipalID: session.Principal.ID, Input: input, Digest: digest})
	if err != nil {
		result(c, nil, err)
		return
	}
	if created {
		payload := gin.H{"remote_id": v.ID, "command": gin.H{"space_id": v.LocalSpaceID, "idempotency_key": v.ID, "device_id": input.DeviceID, "model_revision": input.ModelRevision, "expires_at": input.Expires, "operation": input.Operation}}
		v = s.forwardRemote(c.Request.Context(), binding, v, "commands.create", payload)
	}
	result(c, v, nil)
}
func (s *Server) getRemoteCommand(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	id := c.Param("remote")
	byKey := c.Param("key") != ""
	if byKey {
		id = c.Param("key")
	}
	v, err := s.remote.RemoteCommand(c.Request.Context(), session.Principal.ID, c.Param("space"), id, byKey)
	result(c, v, err)
}
func (s *Server) reconcileRemoteCommand(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	var empty struct{}
	if !body(c, &empty) {
		return
	}
	v, err := s.remote.RemoteCommand(c.Request.Context(), session.Principal.ID, c.Param("space"), c.Param("remote"), false)
	if err != nil {
		result(c, nil, err)
		return
	}
	if terminalRemote(v.Status) {
		result(c, v, nil)
		return
	}
	b, err := s.remoteBinding(c.Request.Context(), session.Principal.ID, v.SpaceID, v.Input.GatewayID, v.Input.Revision, "commands.write")
	if err != nil {
		result(c, nil, err)
		return
	}
	// 只有显式核实原remote_id；未找到也不能证明旧create不会迟到。
	result(c, s.forwardRemote(c.Request.Context(), b, v, "commands.get", gin.H{"remote_id": v.ID}), nil)
}
func (s *Server) forwardRemote(ctx context.Context, b Gateway, v RemoteCommand, action string, payload any) RemoteCommand {
	current, err := s.machines.MachineBinding(ctx, b.ID, b.Revision)
	if err != nil || !sameMachineBinding(current, b) {
		return v
	}
	raw, err := s.relay.call(ctx, b, action, payload)
	if err != nil {
		var failure remoteFailure
		if action == "commands.create" && errors.As(err, &failure) {
			switch failure.code {
			case "device_offline", "device_not_found", "model_mismatch", "command_expired", "unsupported_capability", "invalid_value", "invalid_type", "property_not_found", "property_read_only", "capacity_exceeded", "remote_authorization_rejected", "remote_authorization_expired":
				raw, _ := json.Marshal(gin.H{"error": failure.code})
				if saved, saveErr := s.remote.SaveRemoteResult(ctx, v, "rejected", raw); saveErr == nil {
					return saved
				}
			}
		}
		return v
	}
	var receipt RemoteReceipt
	if json.Unmarshal(raw, &receipt) != nil || !receipt.valid(v) {
		return v
	}
	clean, err := json.Marshal(receipt)
	if err != nil {
		return v
	}
	saved, err := s.remote.SaveRemoteResult(ctx, v, receipt.Status, clean)
	if err != nil {
		return v
	}
	return saved
}
