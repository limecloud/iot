package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/gowebpki/jcs"
)

var (
	ErrOffline  = errors.New("gateway_offline")
	ErrCapacity = errors.New("remote_capacity_reached")
)

func modelRevision(value string) bool {
	if len(value) != 71 || !strings.HasPrefix(value, "sha256:") {
		return false
	}
	for _, c := range value[7:] {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// RawMessage 保留值的JSON数字；规范化集中在RFC8785适配器，不先转换为float64。
func CanonicalDigest(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	canonical, err := jcs.Transform(raw)
	if err != nil {
		return "", err
	}
	return Hash(string(canonical)), nil
}

type RemoteInput struct {
	Key           string          `json:"request_key"`
	GatewayID     string          `json:"gateway_id"`
	Revision      string          `json:"binding_revision"`
	DeviceID      string          `json:"device_id"`
	ModelRevision string          `json:"model_revision"`
	Expires       time.Time       `json:"expires_at"`
	Operation     RemoteOperation `json:"operation"`
}
type RemoteOperation struct {
	Type  string          `json:"type"`
	Path  string          `json:"path"`
	Value json.RawMessage `json:"value"`
}
type RemoteCommand struct {
	ID           string          `json:"remote_id"`
	SpaceID      string          `json:"space_id"`
	PrincipalID  string          `json:"principal_id"`
	LocalSpaceID string          `json:"local_space_id"`
	Digest       string          `json:"request_digest"`
	Input        RemoteInput     `json:"request"`
	Status       string          `json:"status"`
	Result       json.RawMessage `json:"local_result"`
	Created      time.Time       `json:"created_at"`
	Updated      time.Time       `json:"updated_at"`
}

// ReserveRemote 在同一事务核对当前owner、绑定和scope，并在任何发送前耐久记录unknown。
type RemoteCommands interface {
	ReserveRemote(context.Context, RemoteCommand) (RemoteCommand, bool, error)
	RemoteCommand(context.Context, string, string, string, bool) (RemoteCommand, error)
	SaveRemoteResult(context.Context, RemoteCommand, string, json.RawMessage) (RemoteCommand, error)
}

func terminalRemote(status string) bool {
	return status == "confirmed" || status == "failed" || status == "rejected" || status == "expired"
}

// 回执只投影原命令结果，不把内部MQTT信封、机器授权或本地历史返回云客户端。
type RemoteReceipt struct {
	CommandID     string          `json:"command_id"`
	Request       json.RawMessage `json:"request"`
	RequestDigest string          `json:"request_digest"`
	Status        string          `json:"status"`
	Evidence      json.RawMessage `json:"evidence"`
	Error         *string         `json:"error"`
}

func (r RemoteReceipt) valid(original RemoteCommand) bool {
	var request struct {
		SpaceID   string          `json:"space_id"`
		DeviceID  string          `json:"device_id"`
		Revision  string          `json:"model_revision"`
		Key       string          `json:"idempotency_key"`
		Expires   time.Time       `json:"expires_at"`
		Operation RemoteOperation `json:"operation"`
	}
	decoder := json.NewDecoder(bytes.NewReader(r.Request))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil {
		return false
	}
	digest, err := CanonicalDigest(r.Request)
	operation, opErr := CanonicalDigest(request.Operation)
	expected, expectedErr := CanonicalDigest(original.Input.Operation)
	if r.Status == "confirmed" {
		if r.Error != nil {
			return false
		}
		if original.Input.Operation.Type == "action.invoke" {
			if !validActionEvidence(r.Evidence, original) {
				return false
			}
		} else if original.Input.Operation.Type == "property.set" {
			var evidence struct {
				Type     string                     `json:"type"`
				Reported map[string]json.RawMessage `json:"reported"`
			}
			if json.Unmarshal(r.Evidence, &evidence) != nil || evidence.Type != "device_result" || r.Error != nil {
				return false
			}
			actual, actualErr := CanonicalDigest(evidence.Reported[original.Input.Operation.Path])
			wanted, wantedErr := CanonicalDigest(original.Input.Operation.Value)
			if actualErr != nil || wantedErr != nil || actual != wanted || len(evidence.Reported[original.Input.Operation.Path]) == 0 {
				return false
			}
		} else {
			return false
		}
	}
	return err == nil && opErr == nil && expectedErr == nil && identifier(r.CommandID) && "sha256:"+digest == r.RequestDigest &&
		operation == expected && request.SpaceID == original.LocalSpaceID && request.Key == original.ID &&
		request.DeviceID == original.Input.DeviceID && request.Revision == original.Input.ModelRevision && request.Expires.Equal(original.Input.Expires) &&
		(r.Status == "accepted" || r.Status == "dispatched" || r.Status == "unknown" || terminalRemote(r.Status))
}

// 只核对原动作及证据外壳；模型输出规则与完成范围仍由可信网关核心检查。
func validActionEvidence(raw json.RawMessage, original RemoteCommand) bool {
	var evidence struct {
		Type        string          `json:"type"`
		Path        string          `json:"path"`
		InputDigest string          `json:"input_digest"`
		Output      json.RawMessage `json:"output"`
		Completion  string          `json:"completion"`
		Observed    *time.Time      `json:"observed_at"`
	}
	if _, err := CanonicalDigest(raw); err != nil {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&evidence) != nil {
		return false
	}
	digest, err := CanonicalDigest(original.Input.Operation.Value)
	earliest := original.Input.Expires.Add(-30 * time.Second)
	return err == nil && evidence.Type == "action_result" && evidence.Path == original.Input.Operation.Path &&
		evidence.InputDigest == "sha256:"+digest && len(evidence.Output) > 0 && string(evidence.Output) != "null" &&
		(evidence.Completion == "submitted" || evidence.Completion == "observed") && evidence.Observed != nil &&
		!evidence.Observed.Before(earliest.Add(-2*time.Second)) && !evidence.Observed.After(time.Now().UTC().Add(2*time.Second))
}
