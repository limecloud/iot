package control

import (
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const cliParentPrefix = "cli-parent:"

// CLI会话复用本站会话库，绑定当前网页登录；不导出父Cookie或外部提供方Token。
func (s *Server) createCLISession(c *gin.Context) {
	parent, _, ok := s.authenticated(c, "console")
	if !ok || !s.allowed(c, "console:cli-session") {
		return
	}
	var empty struct{}
	if !body(c, &empty) {
		return
	}
	credential, err := open(s.cfg.Key, secretPurpose("console", parent.Hash), parent.Credential)
	if err != nil || strings.HasPrefix(credential, cliParentPrefix) {
		fail(c, 403, "cli_session_not_delegatable")
		return
	}
	child, material, err := s.delegatedSession(parent)
	if err != nil {
		result(c, nil, err)
		return
	}
	if err = s.sessions.SaveSession(c.Request.Context(), child); err != nil {
		result(c, nil, err)
		return
	}
	c.JSON(200, material)
}

// 私有前缀保留既有CLI会话兼容性；原生端复用相同的父会话与当前身份检查。
func (s *Server) delegatedSession(parent Session) (Session, SessionMaterial, error) {
	token := Random()
	hash := Hash(token)
	encrypted, err := seal(s.cfg.Key, secretPurpose("console", hash), cliParentPrefix+parent.Hash)
	if err != nil {
		return Session{}, SessionMaterial{}, err
	}
	expires := time.Now().UTC().Add(time.Hour)
	if parent.Expires.Before(expires) {
		expires = parent.Expires
	}
	child := Session{Hash: hash, Audience: "console", Principal: parent.Principal, Credential: encrypted, Expires: expires}
	return child, SessionMaterial{Version: 1, Origin: s.cfg.Logins["console"].Origin, Audience: "console", Token: token, PrincipalID: parent.Principal.ID, Expires: expires}, nil
}
