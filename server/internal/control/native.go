package control

import (
	"context"
	"time"
)

type NativeAuthorization struct {
	ID, KeyHash, Origin, Platform, Challenge, CodeHash, Status string
	Code, Material                                             []byte
	ParentHash, PrincipalID, ChildHash                         string
	Attempts                                                   int
	Expires, Created                                           time.Time
}

// 原生授权的决定与独立会话在同一事务提交，重读不会重复签发会话。
type NativeAuthorizations interface {
	CreateNativeAuthorization(context.Context, NativeAuthorization) (NativeAuthorization, error)
	NativeAuthorization(context.Context, string, bool) (NativeAuthorization, error)
	DecideNativeAuthorization(context.Context, string, string, string, Session, Session, []byte) (NativeAuthorization, error)
	CancelNativeAuthorization(context.Context, string) (NativeAuthorization, error)
}

type SessionMaterial struct {
	Version     int       `json:"version"`
	Origin      string    `json:"origin"`
	Audience    string    `json:"audience"`
	Token       string    `json:"session"`
	PrincipalID string    `json:"principal_id"`
	Expires     time.Time `json:"expires_at"`
}
