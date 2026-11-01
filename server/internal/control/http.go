package control

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type rateWindow struct {
	start time.Time
	count int
}
type Server struct {
	cfg       Config
	sessions  Sessions
	registry  Registry
	providers map[string]IdentityProvider
	readiness Readiness
	machines  MachineBindings
	relay     *machineHub
	mu        sync.Mutex
	rates     map[string]rateWindow
}

func New(cfg Config, sessions Sessions, registry Registry, machines MachineBindings, readiness Readiness, providers map[string]IdentityProvider) (*Server, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if sessions == nil || registry == nil || machines == nil || readiness == nil {
		return nil, errors.New("store_required")
	}
	if providers == nil {
		providers = map[string]IdentityProvider{}
		for a, l := range cfg.Logins {
			if l.Issuer != "" {
				providers[a] = NewOIDC(l, a)
			}
		}
	}
	return &Server{cfg: cfg, sessions: sessions, registry: registry, machines: machines, readiness: readiness, providers: providers, rates: map[string]rateWindow{}, relay: newMachineHub()}, nil
}
func fail(c *gin.Context, status int, code string) {
	c.AbortWithStatusJSON(status, gin.H{"error": gin.H{"code": code}})
}
func result(c *gin.Context, value any, err error) {
	switch {
	case err == nil:
		c.JSON(200, value)
	case errors.Is(err, ErrMissing):
		fail(c, 404, "not_found")
	case errors.Is(err, ErrConflict):
		fail(c, 409, "idempotency_conflict")
	case errors.Is(err, ErrAlreadyBound):
		fail(c, 409, "gateway_already_bound")
	case errors.Is(err, ErrIdentity):
		fail(c, 401, "identity_rejected")
	case errors.Is(err, ErrProvider):
		fail(c, 503, "identity_unavailable")
	case errors.Is(err, ErrForbidden):
		fail(c, 403, "forbidden")
	default:
		fail(c, 503, "storage_unavailable")
	}
}
func body(c *gin.Context, value any) bool {
	media, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || media != "application/json" {
		fail(c, 415, "json_required")
		return false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 16384))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil || decoder.Decode(new(any)) != io.EOF {
		fail(c, 400, "invalid_request")
		return false
	}
	return true
}
func equal(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(Hash(a)), []byte(Hash(b))) == 1
}
func (s *Server) allowed(c *gin.Context, key string) bool {
	host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err != nil {
		host = c.Request.RemoteAddr
	}
	// 只有固定边缘凭据验证后，才使用本平台代理写入的客户端地址。
	if s.cfg.EdgeToken != "" {
		if ip := net.ParseIP(c.GetHeader("X-LimeIoT-Client-IP")); ip != nil {
			host = ip.String()
		}
	}
	key = host + ":" + key
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	v := s.rates[key]
	if now.Sub(v.start) >= time.Minute {
		v = rateWindow{start: now}
	}
	if _, ok := s.rates[key]; !ok && len(s.rates) >= 4096 {
		for k, v := range s.rates {
			if now.Sub(v.start) >= time.Minute {
				delete(s.rates, k)
			}
		}
		if len(s.rates) >= 4096 {
			fail(c, 429, "rate_limited")
			return false
		}
	}
	if v.count >= 30 {
		fail(c, 429, "rate_limited")
		return false
	}
	v.count++
	s.rates[key] = v
	return true
}
func (s *Server) origin(c *gin.Context, a string) bool {
	if c.GetHeader("Origin") != s.cfg.Logins[a].Origin {
		fail(c, 403, "origin_rejected")
		return false
	}
	return true
}
func (s *Server) Handler() http.Handler {
	r := gin.New()
	r.Use(gin.CustomRecoveryWithWriter(io.Discard, func(c *gin.Context, _ any) { fail(c, 500, "internal_error") }))
	r.Use(func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Referrer-Policy", "no-referrer")
		if c.Request.Method == "GET" && (c.Request.URL.Path == "/health/live" || c.Request.URL.Path == "/health/ready") {
			c.Next()
			return
		}
		origin := s.cfg.Origin
		for _, a := range []string{"console", "admin"} {
			if strings.HasPrefix(c.Request.URL.Path, "/api/"+a+"/") {
				origin = s.cfg.Logins[a].Origin
			}
		}
		u, _ := url.Parse(origin)
		if c.Request.Host != u.Host {
			fail(c, 421, "host_rejected")
			return
		}
		if s.cfg.EdgeToken != "" && !equal(c.GetHeader("X-LimeIoT-Edge-Token"), s.cfg.EdgeToken) {
			fail(c, 403, "edge_rejected")
			return
		}
		c.Next()
	})
	r.GET("/health/live", func(c *gin.Context) { c.JSON(200, gin.H{"status": "ok"}) })
	r.GET("/health/ready", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()
		if s.readiness.Ready(ctx) != nil {
			fail(c, 503, "not_ready")
			return
		}
		c.JSON(200, gin.H{"status": "ready"})
	})
	for _, a := range []string{"console", "admin"} {
		g := r.Group("/api/" + a + "/v1")
		g.GET("/auth/config", func(c *gin.Context) {
			c.JSON(200, gin.H{"local": s.cfg.Mode == "private", "oidc": s.providers[a] != nil})
		})
		g.GET("/auth/session", func(c *gin.Context) { s.session(c, a) })
		g.POST("/auth/local", func(c *gin.Context) { s.localLogin(c, a) })
		g.POST("/auth/start", func(c *gin.Context) { s.startLogin(c, a) })
		g.GET("/auth/callback", func(c *gin.Context) { s.callback(c, a) })
		g.POST("/auth/logout", func(c *gin.Context) { s.logout(c, a) })
	}
	console := r.Group("/api/console/v1")
	console.GET("/spaces", s.spaces)
	console.POST("/spaces", s.createSpace)
	console.POST("/spaces/:space/pairings", s.createPairing)
	console.GET("/spaces/:space/gateways", s.gateways)
	console.GET("/spaces/:space/gateways/:gateway/connection", s.machineConnection)
	console.POST("/spaces/:space/gateways/:gateway/revoke", s.revokeGateway)
	r.POST("/api/pairing/v1/:pairing/review", s.review)
	r.POST("/api/pairing/v1/:pairing/claim", s.claim)
	r.POST("/api/pairing/v1/:pairing/status", s.binding)
	r.GET("/api/gateway/v1/connect", s.connectMachine)
	r.GET("/api/admin/v1/gateways", func(c *gin.Context) {
		if _, _, ok := s.authenticated(c, "admin"); !ok {
			return
		}
		v, err := s.registry.GatewaySummaries(c.Request.Context())
		result(c, gin.H{"gateways": v}, err)
	})
	r.NoRoute(func(c *gin.Context) { fail(c, 404, "not_found") })
	return r
}
