package control

import (
	"context"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func (s *Server) web(c *gin.Context, audience string) {
	directory := s.cfg.WebDirs[audience]
	if directory == "" {
		fail(c, 404, "web_not_installed")
		return
	}
	name := strings.TrimPrefix(c.Param("asset"), "/")
	if name == "" {
		name = "index.html"
	}
	if name != "index.html" && (!strings.HasPrefix(name, "assets/") || strings.Contains(name, "\\") || path.Clean(name) != name) {
		fail(c, 404, "not_found")
		return
	}
	// OpenRoot 保证符号链接也不能穿过构建目录边界；不启用目录列表或源码兜底。
	root, err := os.OpenRoot(directory)
	if err != nil {
		fail(c, 503, "web_unavailable")
		return
	}
	defer root.Close()
	file, err := root.Open(name)
	if err != nil {
		fail(c, 404, "not_found")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 16*1024*1024 {
		fail(c, 404, "not_found")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(file, 16*1024*1024+1))
	if err != nil || len(raw) > 16*1024*1024 {
		fail(c, 503, "web_unavailable")
		return
	}
	c.Header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
	c.Header("X-Frame-Options", "DENY")
	if name != "index.html" {
		c.Header("Cache-Control", "public, max-age=31536000, immutable")
	}
	contentType := mime.TypeByExtension(path.Ext(name))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	c.Data(http.StatusOK, contentType, raw)
}

func (s *Server) adminStatus(c *gin.Context) {
	if _, _, ok := s.authenticated(c, "admin"); !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
	defer cancel()
	storage := "ready"
	if s.readiness.Ready(ctx) != nil {
		storage = "degraded"
	}
	s.relay.mu.Lock()
	connections := 0
	for _, p := range s.relay.peers {
		if p.ready {
			connections++
		}
	}
	capacity := cap(s.relay.slots)
	s.relay.mu.Unlock()
	c.JSON(200, gin.H{"storage": storage, "connections": connections, "connection_capacity": capacity, "sampled_at": time.Now().UTC()})
}
