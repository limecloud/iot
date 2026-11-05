package control

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func nativeID(v string) bool {
	return strings.HasPrefix(v, "na-") && hexSecret(strings.TrimPrefix(v, "na-"))
}
func hexSecret(v string) bool {
	raw, err := hex.DecodeString(v)
	return err == nil && len(raw) == 32 && hex.EncodeToString(raw) == v
}
func challenge(v string) bool {
	raw, err := base64.RawURLEncoding.DecodeString(v)
	return err == nil && len(raw) == 32 && base64.RawURLEncoding.EncodeToString(raw) == v
}
func (s *Server) nativeRequest(c *gin.Context, action string) bool {
	if c.Request.URL.RawQuery != "" || c.GetHeader("Origin") != "" || c.GetHeader("Cookie") != "" || c.GetHeader("Authorization") != "" {
		fail(c, 403, "native_client_required")
		return false
	}
	return s.allowed(c, "native:"+action)
}
func (s *Server) createNativeAuthorization(c *gin.Context) {
	if !s.nativeRequest(c, "create") {
		return
	}
	var input struct {
		Key       string `json:"request_key"`
		Challenge string `json:"code_challenge"`
		Platform  string `json:"platform"`
	}
	if !body(c, &input) {
		return
	}
	if !hexSecret(input.Key) || !challenge(input.Challenge) || !nativePlatform(input.Platform) {
		fail(c, 400, "invalid_request")
		return
	}
	id, code := "na-"+Random(), strings.ToUpper(Random()[:8])
	encrypted, err := seal(s.cfg.Key, "native-code:"+id, code)
	if err != nil {
		result(c, nil, err)
		return
	}
	v, err := s.native.CreateNativeAuthorization(c.Request.Context(), NativeAuthorization{ID: id, KeyHash: Hash(input.Key), Origin: s.cfg.Logins["console"].Origin, Platform: input.Platform, Challenge: input.Challenge, CodeHash: Hash(code), Code: encrypted, Expires: time.Now().UTC().Add(5 * time.Minute).Truncate(time.Microsecond), Created: time.Now().UTC()})
	if err != nil {
		result(c, nil, err)
		return
	}
	if !v.Expires.After(time.Now()) {
		result(c, nil, ErrNativeExpired)
		return
	}
	code, err = open(s.cfg.Key, "native-code:"+v.ID, v.Code)
	if err != nil {
		result(c, nil, ErrIdentity)
		return
	}
	c.JSON(200, gin.H{"authorization_id": v.ID, "user_code": code, "verification_uri": v.Origin + "/console/?native=" + url.QueryEscape(v.ID), "expires_at": v.Expires, "interval_seconds": 3, "status": v.Status})
}
func (s *Server) reviewNativeAuthorization(c *gin.Context) {
	if _, _, ok := s.authenticated(c, "console"); !ok {
		return
	}
	if !nativeID(c.Param("authorization")) {
		fail(c, 400, "invalid_request")
		return
	}
	v, err := s.native.NativeAuthorization(c.Request.Context(), c.Param("authorization"), false)
	if err == nil && v.Origin != s.cfg.Logins["console"].Origin {
		err = ErrMissing
	}
	if err == nil && !v.Expires.After(time.Now()) {
		err = ErrNativeExpired
	}
	if err != nil {
		result(c, nil, err)
		return
	}
	c.JSON(200, gin.H{"authorization_id": v.ID, "platform": v.Platform, "expires_at": v.Expires, "status": v.Status})
}
func (s *Server) decideNativeAuthorization(c *gin.Context) {
	parent, _, ok := s.authenticated(c, "console")
	if !ok || !s.allowed(c, "native:decide") {
		return
	}
	credential, err := open(s.cfg.Key, secretPurpose("console", parent.Hash), parent.Credential)
	if err != nil || strings.HasPrefix(credential, cliParentPrefix) {
		fail(c, 403, "session_not_delegatable")
		return
	}
	var input struct {
		Code     string `json:"user_code"`
		Decision string `json:"decision"`
	}
	if !body(c, &input) {
		return
	}
	if !nativeID(c.Param("authorization")) || len(input.Code) != 8 || (input.Decision != "approve" && input.Decision != "deny") {
		fail(c, 400, "invalid_request")
		return
	}
	var child Session
	var material []byte
	if input.Decision == "approve" {
		var secret SessionMaterial
		child, secret, err = s.delegatedSession(parent)
		if err == nil {
			var raw []byte
			raw, err = json.Marshal(secret)
			if err == nil {
				material, err = seal(s.cfg.Key, "native-result:"+c.Param("authorization"), string(raw))
			}
		}
		if err != nil {
			result(c, nil, err)
			return
		}
	}
	v, err := s.native.DecideNativeAuthorization(c.Request.Context(), c.Param("authorization"), s.cfg.Logins["console"].Origin, Hash(strings.ToUpper(input.Code)), parent, child, material)
	if err != nil {
		result(c, nil, err)
		return
	}
	c.JSON(200, gin.H{"status": v.Status, "authorization_id": v.ID})
}
func (s *Server) nativeProof(c *gin.Context, action string) (NativeAuthorization, bool) {
	if !s.nativeRequest(c, action) {
		return NativeAuthorization{}, false
	}
	var input struct {
		Key      string `json:"request_key"`
		Verifier string `json:"code_verifier"`
	}
	if !body(c, &input) {
		return NativeAuthorization{}, false
	}
	if !hexSecret(input.Key) || len(input.Verifier) < 43 || len(input.Verifier) > 128 {
		fail(c, 400, "invalid_request")
		return NativeAuthorization{}, false
	}
	for _, r := range input.Verifier {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-._~", r)) {
			fail(c, 400, "invalid_request")
			return NativeAuthorization{}, false
		}
	}
	v, err := s.native.NativeAuthorization(c.Request.Context(), Hash(input.Key), true)
	digest := sha256.Sum256([]byte(input.Verifier))
	if errors.Is(err, ErrMissing) || err == nil && (v.Origin != s.cfg.Logins["console"].Origin || !equal(v.Challenge, base64.RawURLEncoding.EncodeToString(digest[:]))) {
		fail(c, 401, "identity_rejected")
		return v, false
	}
	if err != nil {
		result(c, nil, err)
		return v, false
	}
	return v, true
}
func (s *Server) pollNativeAuthorization(c *gin.Context) {
	v, ok := s.nativeProof(c, "poll")
	if !ok {
		return
	}
	if !v.Expires.After(time.Now()) {
		result(c, nil, ErrNativeExpired)
		return
	}
	if v.Status != "approved" {
		c.JSON(200, gin.H{"status": v.Status, "expires_at": v.Expires})
		return
	}
	raw, err := open(s.cfg.Key, "native-result:"+v.ID, v.Material)
	var material SessionMaterial
	if err == nil {
		err = json.Unmarshal([]byte(raw), &material)
	}
	if err != nil || Hash(material.Token) != v.ChildHash || material.PrincipalID != v.PrincipalID || material.Origin != v.Origin {
		result(c, nil, ErrIdentity)
		return
	}
	child, err := s.sessions.Session(c.Request.Context(), v.ChildHash, "console")
	if errors.Is(err, ErrMissing) {
		err = ErrIdentity
	}
	if err == nil {
		err = s.validateStoredSession(c.Request.Context(), child, "console", true)
	}
	if err != nil {
		result(c, nil, err)
		return
	}
	// 只读同一材料，响应丢失也不会再次创建会话；返回前再次核对并发取消。
	current, err := s.native.NativeAuthorization(c.Request.Context(), v.ID, false)
	if err != nil {
		result(c, nil, err)
		return
	}
	if current.Status != "approved" {
		c.JSON(200, gin.H{"status": current.Status, "expires_at": current.Expires})
		return
	}
	c.JSON(200, gin.H{"status": "approved", "expires_at": v.Expires, "material": material})
}
func (s *Server) cancelNativeAuthorization(c *gin.Context) {
	v, ok := s.nativeProof(c, "cancel")
	if !ok {
		return
	}
	v, err := s.native.CancelNativeAuthorization(c.Request.Context(), v.KeyHash)
	if err != nil {
		result(c, nil, err)
		return
	}
	c.JSON(200, gin.H{"status": v.Status})
}
