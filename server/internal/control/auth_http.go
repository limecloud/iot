package control

import (
	"context"
	"errors"
	"github.com/gin-gonic/gin"
	"net/http"
	"strings"
	"time"
)

func (s *Server) cookieName(a, kind string) string {
	name := "limeiot_" + a
	if kind != "" {
		name += "_" + kind
	}
	if strings.HasPrefix(s.cfg.Logins[a].Origin, "https:") {
		name = "__Host-" + name
	}
	return name
}
func (s *Server) cookie(c *gin.Context, a, kind, value string, max int) {
	http.SetCookie(c.Writer, &http.Cookie{Name: s.cookieName(a, kind), Value: value, Path: "/", MaxAge: max, Secure: strings.HasPrefix(s.cfg.Logins[a].Origin, "https:"), HttpOnly: true, SameSite: http.SameSiteLaxMode})
}
func (s *Server) authenticated(c *gin.Context, a string) (Session, string, bool) {
	return s.authenticate(c, a, true)
}
func (s *Server) authenticate(c *gin.Context, a string, checkProvider bool) (Session, string, bool) {
	raw, err := c.Cookie(s.cookieName(a, ""))
	if err != nil || len(raw) != 64 {
		fail(c, 401, "authentication_required")
		return Session{}, "", false
	}
	session, err := s.sessions.Session(c.Request.Context(), Hash(raw), a)
	if err != nil {
		if errors.Is(err, ErrMissing) {
			fail(c, 401, "authentication_required")
		} else {
			result(c, nil, err)
		}
		return session, "", false
	}
	err = s.validateStoredSession(c.Request.Context(), session, a, checkProvider)
	if err != nil {
		if errors.Is(err, ErrIdentity) {
			_ = s.sessions.RevokeSession(c.Request.Context(), session.Hash, a)
			s.cookie(c, a, "", "", -1)
		}
		result(c, nil, err)
		return session, "", false
	}
	if c.Request.Method != "GET" && c.Request.Method != "HEAD" {
		if !s.origin(c, a) {
			return session, "", false
		}
		if !equal(c.GetHeader("X-CSRF-Token"), Hash("limeiot-csrf:"+a+":"+raw)) {
			fail(c, 403, "csrf_rejected")
			return session, "", false
		}
	}
	return session, raw, true
}

func (s *Server) validateStoredSession(ctx context.Context, session Session, a string, checkProvider bool) error {
	credential, err := open(s.cfg.Key, secretPurpose(a, session.Hash), session.Credential)
	identitySession := session
	if err == nil && !session.External && strings.HasPrefix(credential, cliParentPrefix) {
		if a != "console" {
			err = ErrIdentity
		} else {
			parent, parentErr := s.sessions.Session(ctx, strings.TrimPrefix(credential, cliParentPrefix), a)
			if parentErr != nil && !errors.Is(parentErr, ErrMissing) {
				return parentErr
			}
			if parentErr != nil || parent.Principal.ID != session.Principal.ID || session.Expires.After(parent.Expires) {
				err = ErrIdentity
			} else {
				identitySession = parent
				credential, err = open(s.cfg.Key, secretPurpose(a, parent.Hash), parent.Credential)
				if err == nil && strings.HasPrefix(credential, cliParentPrefix) {
					err = ErrIdentity
				}
			}
		}
	}
	if err == nil && identitySession.External {
		provider := s.providers[a]
		if provider == nil || identitySession.Principal.Issuer != s.cfg.Logins[a].Issuer {
			err = ErrIdentity
		} else if checkProvider {
			var subject string
			subject, err = provider.Current(ctx, credential)
			if err == nil && subject != identitySession.Principal.Subject {
				err = ErrIdentity
			}
		}
	} else if err == nil {
		if s.cfg.Mode != "private" || !equal(credential, Hash(s.cfg.Logins[a].LocalToken)) {
			err = ErrIdentity
		}
	}
	if err == nil && a == "admin" && session.External && !s.cfg.Logins[a].Operators[session.Principal.Subject] {
		err = ErrIdentity
	}
	if err != nil {
		if !errors.Is(err, ErrProvider) {
			return ErrIdentity
		}
		return err
	}
	return nil
}
func (s *Server) session(c *gin.Context, a string) {
	session, raw, ok := s.authenticated(c, a)
	if !ok {
		return
	}
	c.JSON(200, gin.H{"principal": session.Principal, "audience": a, "expires_at": session.Expires, "csrf_token": Hash("limeiot-csrf:" + a + ":" + raw)})
}
func (s *Server) saveSession(c *gin.Context, a string, id Identity, external bool) error {
	if a == "admin" && external && !s.cfg.Logins[a].Operators[id.Subject] {
		return ErrForbidden
	}
	principal, err := s.sessions.Principal(c.Request.Context(), id)
	if err != nil {
		return err
	}
	raw := Random()
	hash := Hash(raw)
	secret := id.AccessToken
	if !external {
		secret = Hash(s.cfg.Logins[a].LocalToken)
	}
	credential, err := seal(s.cfg.Key, secretPurpose(a, hash), secret)
	if err != nil {
		return err
	}
	expires := time.Now().Add(8 * time.Hour)
	if external && id.Expires.Before(expires) {
		expires = id.Expires
	}
	if !expires.After(time.Now()) {
		return ErrIdentity
	}
	if err = s.sessions.SaveSession(c.Request.Context(), Session{Hash: hash, Audience: a, Principal: principal, Credential: credential, External: external, Expires: expires}); err != nil {
		return err
	}
	if old, e := c.Cookie(s.cookieName(a, "")); e == nil && len(old) == 64 {
		if err = s.sessions.RevokeSession(c.Request.Context(), Hash(old), a); err != nil {
			_ = s.sessions.RevokeSession(c.Request.Context(), hash, a)
			return err
		}
	}
	s.cookie(c, a, "", raw, int(time.Until(expires).Seconds()))
	return nil
}
func (s *Server) localLogin(c *gin.Context, a string) {
	if !s.origin(c, a) || !s.allowed(c, a+":login") {
		return
	}
	if s.cfg.Mode != "private" {
		fail(c, 404, "not_found")
		return
	}
	var v struct {
		Token string `json:"token"`
	}
	if !body(c, &v) {
		return
	}
	if !equal(v.Token, s.cfg.Logins[a].LocalToken) {
		fail(c, 401, "identity_rejected")
		return
	}
	err := s.saveSession(c, a, Identity{Issuer: s.cfg.Origin + "/local/" + a, Subject: a, Name: map[string]string{"console": "本地所有者", "admin": "实例管理员"}[a]}, false)
	if err != nil {
		result(c, nil, err)
		return
	}
	c.JSON(200, gin.H{"logged_in": true})
}
func (s *Server) startLogin(c *gin.Context, a string) {
	if !s.origin(c, a) || !s.allowed(c, a+":oidc") {
		return
	}
	p := s.providers[a]
	if p == nil {
		fail(c, 404, "not_found")
		return
	}
	var input struct {
		Native string `json:"native_authorization,omitempty"`
	}
	if !body(c, &input) {
		return
	}
	flowPrefix := s.cookieName(a, "flow_")
	pending := 0
	for _, cookie := range c.Request.Cookies() {
		if strings.HasPrefix(cookie.Name, flowPrefix) && hexSecret(strings.TrimPrefix(cookie.Name, flowPrefix)) {
			pending++
		}
	}
	if pending >= 8 {
		fail(c, 429, "rate_limited")
		return
	}
	if input.Native != "" {
		if a != "console" || !nativeID(input.Native) {
			fail(c, 400, "invalid_request")
			return
		}
		v, err := s.native.NativeAuthorization(c.Request.Context(), input.Native, false)
		if err == nil && (v.Origin != s.cfg.Logins[a].Origin || !v.Expires.After(time.Now()) || v.Status != "pending") {
			err = ErrNativeExpired
		}
		if err != nil {
			result(c, nil, err)
			return
		}
	}
	raw, state, nonce, verifier := Random(), Random(), Random(), Random()
	location, err := p.Authorize(c.Request.Context(), state, nonce, verifier)
	if err != nil {
		result(c, nil, err)
		return
	}
	savedVerifier := verifier
	if input.Native != "" {
		savedVerifier = "native:" + input.Native + ":" + verifier
	}
	encrypted, err := seal(s.cfg.Key, "flow:"+a+":"+Hash(raw), savedVerifier)
	if err != nil {
		result(c, nil, err)
		return
	}
	if err = s.sessions.SaveFlow(c.Request.Context(), Flow{Hash: Hash(raw), StateHash: Hash(state), Audience: a, Nonce: nonce, Verifier: encrypted, Expires: time.Now().Add(5 * time.Minute)}); err != nil {
		result(c, nil, err)
		return
	}
	// 标签页共享 Cookie；按 state 区分流程，避免后一次登录覆盖前一次。
	s.cookie(c, a, "flow_"+state, raw, 300)
	c.JSON(200, gin.H{"authorize_url": location})
}
func (s *Server) callback(c *gin.Context, a string) {
	if !s.allowed(c, a+":callback") {
		return
	}
	p := s.providers[a]
	if p == nil {
		fail(c, 404, "not_found")
		return
	}
	state := c.Query("state")
	code := c.Query("code")
	if !hexSecret(state) || (c.Query("error") == "" && (len(code) < 1 || len(code) > 8192)) {
		fail(c, 401, "identity_rejected")
		return
	}
	kind := "flow_" + state
	raw, err := c.Cookie(s.cookieName(a, kind))
	if errors.Is(err, http.ErrNoCookie) {
		// 允许滚动部署前已发起的短期流程完成，仍核对原 state 和单次记录。
		kind = "flow"
		raw, err = c.Cookie(s.cookieName(a, kind))
	}
	if err != nil || !hexSecret(raw) {
		fail(c, 401, "identity_rejected")
		return
	}
	flow, err := s.sessions.TakeFlow(c.Request.Context(), Hash(raw), Hash(state), a)
	if err != nil {
		if errors.Is(err, ErrMissing) {
			err = ErrIdentity
		}
		result(c, nil, err)
		return
	}
	s.cookie(c, a, kind, "", -1)
	if c.Query("error") != "" {
		fail(c, 401, "identity_rejected")
		return
	}
	verifier, err := open(s.cfg.Key, "flow:"+a+":"+Hash(raw), flow.Verifier)
	if err != nil {
		result(c, nil, ErrIdentity)
		return
	}
	nativeAuthorization := ""
	if strings.HasPrefix(verifier, "native:") {
		parts := strings.Split(verifier, ":")
		if a != "console" || len(parts) != 3 || !nativeID(parts[1]) || !hexSecret(parts[2]) {
			result(c, nil, ErrIdentity)
			return
		}
		nativeAuthorization = parts[1]
		verifier = parts[2]
	}
	id, err := p.Exchange(c.Request.Context(), code, verifier, flow.Nonce)
	if err == nil {
		err = s.saveSession(c, a, id, true)
	}
	if err != nil {
		if id.AccessToken != "" {
			s.revoke(p, id.AccessToken)
		}
		result(c, nil, err)
		return
	}
	target := "/" + a + "/"
	if nativeAuthorization != "" {
		target += "?native=" + nativeAuthorization
	}
	c.Redirect(http.StatusSeeOther, target)
}
func (s *Server) revoke(p IdentityProvider, token string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = p.Revoke(ctx, token)
}
func (s *Server) logout(c *gin.Context, a string) {
	session, _, ok := s.authenticate(c, a, false)
	if !ok {
		return
	}
	if err := s.sessions.RevokeSession(c.Request.Context(), session.Hash, a); err != nil {
		result(c, nil, err)
		return
	}
	s.cookie(c, a, "", "", -1)
	if session.External {
		if token, err := open(s.cfg.Key, secretPurpose(a, session.Hash), session.Credential); err == nil {
			if p := s.providers[a]; p != nil {
				s.revoke(p, token)
			}
		}
	}
	c.JSON(200, gin.H{"logged_out": true})
}
