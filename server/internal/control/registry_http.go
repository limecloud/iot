package control

import (
	"github.com/gin-gonic/gin"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

func (s *Server) spaces(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	v, err := s.registry.Spaces(c.Request.Context(), session.Principal.ID)
	result(c, gin.H{"spaces": v}, err)
}
func (s *Server) createSpace(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	var v struct {
		Key  string `json:"request_key"`
		Name string `json:"name"`
	}
	if !body(c, &v) {
		return
	}
	v.Name = strings.TrimSpace(v.Name)
	if !identifier(v.Key) || v.Name == "" || !utf8.ValidString(v.Name) || utf8.RuneCountInString(v.Name) > 80 {
		fail(c, 400, "invalid_request")
		return
	}
	space, err := s.registry.CreateSpace(c.Request.Context(), session.Principal.ID, v.Key, v.Name, Hash(v.Name))
	result(c, space, err)
}

var validScopes = map[string]bool{"devices.read": true, "commands.write": true, "rules.read": true, "rules.write": true}

func (s *Server) createPairing(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	var v struct {
		Key    string   `json:"request_key"`
		Scopes []string `json:"scopes"`
	}
	if !body(c, &v) {
		return
	}
	if !identifier(v.Key) || !identifier(c.Param("space")) || len(v.Scopes) == 0 || len(v.Scopes) > 4 {
		fail(c, 400, "invalid_request")
		return
	}
	sort.Strings(v.Scopes)
	for i, scope := range v.Scopes {
		if !validScopes[scope] || (i > 0 && scope == v.Scopes[i-1]) {
			fail(c, 400, "invalid_scope")
			return
		}
	}
	code := Random()
	pairing := Pairing{ID: "pair-" + Random(), SpaceID: c.Param("space"), Principal: session.Principal, Challenge: Random(), Scopes: v.Scopes, Expires: time.Now().Add(120 * time.Second).Truncate(time.Second), CodeHash: Hash(code), RequestKey: v.Key, Digest: Hash(strings.Join(v.Scopes, "\n"))}
	var err error
	pairing.Code, err = seal(s.cfg.Key, "pairing:"+pairing.ID, code)
	if err != nil {
		result(c, nil, err)
		return
	}
	pairing, err = s.registry.SavePairing(c.Request.Context(), pairing)
	if err != nil {
		result(c, nil, err)
		return
	}
	code, err = open(s.cfg.Key, "pairing:"+pairing.ID, pairing.Code)
	if err != nil {
		result(c, nil, err)
		return
	}
	c.JSON(200, gin.H{"pairing": pairing, "code": code, "control_origin": s.cfg.Origin})
}
func (s *Server) pairing(c *gin.Context, code string) (Pairing, bool) {
	if !identifier(c.Param("pairing")) || len(code) != 64 {
		fail(c, 401, "identity_rejected")
		return Pairing{}, false
	}
	v, err := s.registry.Pairing(c.Request.Context(), c.Param("pairing"), Hash(code))
	if err != nil {
		result(c, nil, err)
		return v, false
	}
	if v.Cancelled || (!v.Claimed && !v.Expires.After(time.Now())) {
		fail(c, 410, "pairing_expired")
		return v, false
	}
	return v, true
}
func (s *Server) review(c *gin.Context) {
	if !s.allowed(c, "pairing") {
		return
	}
	var v struct {
		Code string `json:"code"`
	}
	if !body(c, &v) {
		return
	}
	p, ok := s.pairing(c, v.Code)
	if !ok {
		return
	}
	c.JSON(200, gin.H{"pairing": p, "control_origin": s.cfg.Origin})
}
func (s *Server) claim(c *gin.Context) {
	if !s.allowed(c, "pairing") {
		return
	}
	var v Claim
	if !body(c, &v) {
		return
	}
	p, ok := s.pairing(c, v.Code)
	if !ok {
		return
	}
	if err := verifyClaim(s.cfg.Origin, p, v); err != nil {
		result(c, nil, err)
		return
	}
	binding, err := s.registry.Claim(c.Request.Context(), p, v)
	result(c, binding, err)
}
func (s *Server) binding(c *gin.Context) {
	if !s.allowed(c, "pairing") {
		return
	}
	var v Claim
	if !body(c, &v) {
		return
	}
	p, ok := s.pairing(c, v.Code)
	if !ok {
		return
	}
	if err := verifyClaim(s.cfg.Origin, p, v); err != nil {
		result(c, nil, err)
		return
	}
	binding, err := s.registry.Binding(c.Request.Context(), p, v)
	result(c, binding, err)
}
func (s *Server) gateways(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	v, err := s.registry.Gateways(c.Request.Context(), session.Principal.ID, c.Param("space"))
	result(c, gin.H{"gateways": v}, err)
}
func (s *Server) revokeGateway(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	var v struct {
		Revision string `json:"revision"`
	}
	if !body(c, &v) {
		return
	}
	if !identifier(v.Revision) {
		fail(c, 400, "invalid_request")
		return
	}
	err := s.registry.RevokeGateway(c.Request.Context(), session.Principal.ID, c.Param("space"), c.Param("gateway"), v.Revision)
	if err == nil {
		s.relay.disconnect(c.Param("gateway"), v.Revision)
	}
	result(c, gin.H{"revoked": true}, err)
}
