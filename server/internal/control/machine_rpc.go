package control

import (
	"context"
	"encoding/json"
	"time"
)

type machineResult struct {
	Type         string          `json:"type"`
	ConnectionID string          `json:"connection_id"`
	RequestID    string          `json:"request_id"`
	Revision     string          `json:"binding_revision"`
	Result       json.RawMessage `json:"result"`
	Error        *string         `json:"error"`
}
type machinePending struct{ result chan machineResult }

type remoteFailure struct{ code string }

func (e remoteFailure) Error() string { return e.code }

func (h *machineHub) call(ctx context.Context, b Gateway, action string, payload any) (json.RawMessage, error) {
	switch action {
	case "devices.list", "models.get", "commands.create", "commands.get":
	default:
		return nil, ErrForbidden
	}
	h.mu.Lock()
	p := h.peers[b.ID]
	if p == nil || !p.ready || !sameMachineBinding(p.binding, b) {
		h.mu.Unlock()
		return nil, ErrOffline
	}
	if len(p.pending) >= 16 {
		h.mu.Unlock()
		return nil, ErrCapacity
	}
	id := "rpc-" + Random()
	wait := machinePending{result: make(chan machineResult, 1)}
	p.pending[id] = wait
	h.mu.Unlock()
	defer func() { h.mu.Lock(); delete(p.pending, id); h.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	frame := map[string]any{"type": "request", "connection_id": p.connectionID, "request_id": id, "binding_revision": b.Revision, "space_id": b.SpaceID, "local_space_id": b.LocalSpaceID, "principal_id": b.PrincipalID, "expires_at": time.Now().UTC().Add(9 * time.Second), "action": action, "payload": payload}
	if machineWrite(ctx, p.conn, frame) != nil {
		return nil, ErrOffline
	}
	select {
	case r := <-wait.result:
		if r.Error != nil {
			return nil, remoteFailure{code: *r.Error}
		}
		return r.Result, nil
	case <-p.done:
		return nil, ErrOffline
	case <-ctx.Done():
		return nil, ErrOffline
	}
}
