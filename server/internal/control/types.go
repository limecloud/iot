package control

import (
	"context"
	"errors"
	"time"
)

var (
	ErrMissing       = errors.New("not_found")
	ErrConflict      = errors.New("idempotency_conflict")
	ErrIdentity      = errors.New("identity_rejected")
	ErrProvider      = errors.New("identity_unavailable")
	ErrForbidden     = errors.New("forbidden")
	ErrAlreadyBound  = errors.New("gateway_already_bound")
	ErrNativeExpired = errors.New("native_authorization_expired")
)

type Principal struct {
	ID      string `json:"principal_id"`
	Issuer  string `json:"issuer"`
	Subject string `json:"subject"`
	Name    string `json:"name"`
}
type Identity struct {
	Issuer, Subject, Name, AccessToken string
	Expires                            time.Time
}
type IdentityProvider interface {
	Authorize(context.Context, string, string, string) (string, error)
	Exchange(context.Context, string, string, string) (Identity, error)
	Current(context.Context, string) (string, error)
	Revoke(context.Context, string) error
}
type Readiness interface{ Ready(context.Context) error }
type Session struct {
	Hash, Audience string
	Principal      Principal
	Credential     []byte
	External       bool
	Expires        time.Time
}
type Flow struct {
	Hash, StateHash, Audience, Nonce string
	Verifier                         []byte
	Expires                          time.Time
}
type Sessions interface {
	Principal(context.Context, Identity) (Principal, error)
	SaveSession(context.Context, Session) error
	Session(context.Context, string, string) (Session, error)
	RevokeSession(context.Context, string, string) error
	SaveFlow(context.Context, Flow) error
	TakeFlow(context.Context, string, string, string) (Flow, error)
	Sweep(context.Context) error
}
type Space struct {
	ID      string    `json:"space_id"`
	Name    string    `json:"name"`
	Created time.Time `json:"created_at"`
}
type Pairing struct {
	ID                 string    `json:"pairing_id"`
	SpaceID            string    `json:"space_id"`
	Principal          Principal `json:"owner"`
	Challenge          string    `json:"challenge"`
	Scopes             []string  `json:"scopes"`
	Expires            time.Time `json:"expires_at"`
	Claimed            bool      `json:"claimed"`
	Cancelled          bool      `json:"cancelled"`
	Code               []byte    `json:"-"`
	CodeHash           string    `json:"-"`
	RequestKey, Digest string    `json:"-"`
}
type Claim struct {
	Code         string `json:"code"`
	GatewayID    string `json:"gateway_id"`
	LocalSpaceID string `json:"local_space_id"`
	PublicKey    string `json:"public_key"`
	Signature    string `json:"signature"`
}
type Gateway struct {
	ID           string    `json:"gateway_id"`
	SpaceID      string    `json:"space_id"`
	LocalSpaceID string    `json:"local_space_id"`
	PrincipalID  string    `json:"principal_id"`
	PublicKey    string    `json:"public_key"`
	Scopes       []string  `json:"scopes"`
	Revision     string    `json:"revision"`
	Active       bool      `json:"active"`
	Created      time.Time `json:"created_at"`
}
type Registry interface {
	CreateSpace(context.Context, string, string, string, string) (Space, error)
	Spaces(context.Context, string) ([]Space, error)
	Owns(context.Context, string, string) (bool, error)
	SavePairing(context.Context, Pairing) (Pairing, error)
	Pairing(context.Context, string, string) (Pairing, error)
	Claim(context.Context, Pairing, Claim) (Gateway, error)
	Binding(context.Context, Pairing, Claim) (Gateway, error)
	Gateways(context.Context, string, string) ([]Gateway, error)
	RevokeGateway(context.Context, string, string, string, string) error
	GatewaySummaries(context.Context) ([]GatewaySummary, error)
}
type GatewaySummary struct {
	ID      string    `json:"gateway_id"`
	Active  bool      `json:"active"`
	Created time.Time `json:"created_at"`
}

// MachineBindings 只读取当前机器绑定，不使用浏览器会话或配对码认证连接。
type MachineBindings interface {
	MachineBinding(context.Context, string, string) (Gateway, error)
}
