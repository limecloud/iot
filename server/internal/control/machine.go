package control

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
)

const machineProtocol = "limeiot.relay.v1"

// coder 的 Gin 兼容分支会在 Hijack 前调用 WriteHeaderNow，Gin 1.11
// 此时拒绝 Hijack。只在101时直写原响应头，由Gin的Hijack标记已接管。
type machineUpgradeWriter struct {
	writer gin.ResponseWriter
	raw    http.ResponseWriter
}

func (w machineUpgradeWriter) Header() http.Header         { return w.writer.Header() }
func (w machineUpgradeWriter) Write(p []byte) (int, error) { return w.writer.Write(p) }
func (w machineUpgradeWriter) WriteHeader(code int) {
	w.writer.WriteHeader(code)
	if code == http.StatusSwitchingProtocols {
		w.raw.WriteHeader(code)
	}
}
func (w machineUpgradeWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) { return w.writer.Hijack() }

type ConnectionChallenge struct {
	Type         string    `json:"type"`
	Origin       string    `json:"control_origin"`
	ConnectionID string    `json:"connection_id"`
	Challenge    string    `json:"challenge"`
	Expires      time.Time `json:"expires_at"`
}

type MachineAuthentication struct {
	Type         string `json:"type"`
	GatewayID    string `json:"gateway_id"`
	SpaceID      string `json:"space_id"`
	LocalSpaceID string `json:"local_space_id"`
	PrincipalID  string `json:"principal_id"`
	Revision     string `json:"revision"`
	Signature    string `json:"signature"`
}

func ConnectionProof(challenge ConnectionChallenge, binding Gateway) string {
	return strings.Join([]string{"LIMEIOT-CONNECT-1", challenge.Origin, challenge.ConnectionID, challenge.Challenge, strconv.FormatInt(challenge.Expires.Unix(), 10), binding.SpaceID, binding.ID, binding.LocalSpaceID, binding.PrincipalID, binding.Revision}, "\n")
}

type ConnectionView struct {
	Connected   bool       `json:"connected"`
	Revision    string     `json:"binding_revision,omitempty"`
	ConnectedAt *time.Time `json:"connected_at,omitempty"`
	LastSeen    *time.Time `json:"last_seen_at,omitempty"`
}

type machinePeer struct {
	conn      *websocket.Conn
	binding   Gateway
	connected time.Time
	lastSeen  time.Time
}

// 每个进程只维护当前传输连接；业务执行事实不保存在连接表中。
type machineHub struct {
	mu     sync.Mutex
	peers  map[string]*machinePeer
	all    map[*websocket.Conn]bool
	slots  chan struct{}
	closed bool
}

func newMachineHub() *machineHub {
	return &machineHub{peers: map[string]*machinePeer{}, all: map[*websocket.Conn]bool{}, slots: make(chan struct{}, 128)}
}

func (s *Server) Close() {
	s.relay.mu.Lock()
	s.relay.closed = true
	connections := make([]*websocket.Conn, 0, len(s.relay.all))
	for conn := range s.relay.all {
		connections = append(connections, conn)
	}
	s.relay.mu.Unlock()
	for _, conn := range connections {
		_ = conn.CloseNow()
	}
}

func (h *machineHub) track(conn *websocket.Conn) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return false
	}
	h.all[conn] = true
	return true
}

func (h *machineHub) register(p *machinePeer) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.peers[p.binding.ID] != nil {
		return false
	}
	h.peers[p.binding.ID] = p
	return true
}

func (h *machineHub) remove(conn *websocket.Conn, p *machinePeer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.all, conn)
	if p != nil && h.peers[p.binding.ID] == p {
		delete(h.peers, p.binding.ID)
	}
}

func (h *machineHub) disconnect(id, revision string) {
	h.mu.Lock()
	p := h.peers[id]
	if p != nil && p.binding.Revision != revision {
		p = nil
	}
	h.mu.Unlock()
	if p != nil {
		_ = p.conn.CloseNow()
	}
}

func (h *machineHub) view(b Gateway) ConnectionView {
	h.mu.Lock()
	defer h.mu.Unlock()
	p := h.peers[b.ID]
	if !b.Active || p == nil || p.binding.Revision != b.Revision {
		return ConnectionView{Connected: false}
	}
	connected, seen := p.connected, p.lastSeen
	return ConnectionView{Connected: true, Revision: b.Revision, ConnectedAt: &connected, LastSeen: &seen}
}

func machineRead(ctx context.Context, conn *websocket.Conn, value any) error {
	kind, raw, err := conn.Read(ctx)
	if err != nil {
		return err
	}
	if kind != websocket.MessageText {
		return ErrIdentity
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil || decoder.Decode(new(any)) != io.EOF {
		return ErrIdentity
	}
	return nil
}

func machineWrite(ctx context.Context, conn *websocket.Conn, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return conn.Write(writeCtx, websocket.MessageText, raw)
}

func (s *Server) connectMachine(c *gin.Context) {
	// 浏览器身份、Cookie和URL参数不用于机器连接认证。
	if c.GetHeader("Origin") != "" || c.GetHeader("Cookie") != "" || c.GetHeader("Authorization") != "" {
		fail(c, 403, "machine_identity_required")
		return
	}
	if c.Request.URL.RawQuery != "" || c.Request.URL.ForceQuery || c.GetHeader("Sec-WebSocket-Protocol") != machineProtocol {
		fail(c, 400, "invalid_machine_handshake")
		return
	}
	if !s.allowed(c, "machine") {
		return
	}
	select {
	case s.relay.slots <- struct{}{}:
		defer func() { <-s.relay.slots }()
	default:
		fail(c, 503, "machine_capacity_reached")
		return
	}
	unwrapper, ok := c.Writer.(interface{ Unwrap() http.ResponseWriter })
	if !ok {
		fail(c, 503, "machine_transport_unavailable")
		return
	}
	conn, err := websocket.Accept(machineUpgradeWriter{writer: c.Writer, raw: unwrapper.Unwrap()}, c.Request, &websocket.AcceptOptions{Subprotocols: []string{machineProtocol}, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	conn.SetReadLimit(16384)
	var peer *machinePeer
	defer func() { s.relay.remove(conn, peer); _ = conn.CloseNow() }()
	if !s.relay.track(conn) {
		return
	}
	connectionCtx, stop := context.WithCancel(context.Background())
	defer stop()
	challenge := ConnectionChallenge{Type: "challenge", Origin: s.cfg.Origin, ConnectionID: "conn-" + Random(), Challenge: Random(), Expires: time.Now().Add(15 * time.Second).UTC().Truncate(time.Second)}
	ctx, cancel := context.WithDeadline(connectionCtx, challenge.Expires)
	defer cancel()
	if machineWrite(ctx, conn, challenge) != nil {
		return
	}
	var auth MachineAuthentication
	if machineRead(ctx, conn, &auth) != nil || auth.Type != "authenticate" || !identifier(auth.GatewayID) || !identifier(auth.Revision) {
		return
	}
	binding, err := s.machines.MachineBinding(ctx, auth.GatewayID, auth.Revision)
	if err != nil || binding.SpaceID != auth.SpaceID || binding.LocalSpaceID != auth.LocalSpaceID || binding.PrincipalID != auth.PrincipalID || !binding.Active {
		return
	}
	key, err := base64.StdEncoding.DecodeString(binding.PublicKey)
	signature, signatureErr := base64.StdEncoding.DecodeString(auth.Signature)
	if err != nil || signatureErr != nil || len(key) != ed25519.PublicKeySize || len(signature) != ed25519.SignatureSize || base64.StdEncoding.EncodeToString(signature) != auth.Signature || !ed25519.Verify(key, []byte(ConnectionProof(challenge, binding)), signature) || !time.Now().Before(challenge.Expires) {
		return
	}
	now := time.Now().UTC()
	peer = &machinePeer{conn: conn, binding: binding, connected: now, lastSeen: now}
	if !s.relay.register(peer) {
		_ = machineWrite(ctx, conn, gin.H{"type": "error", "code": "machine_already_connected"})
		return
	}
	if machineWrite(ctx, conn, gin.H{"type": "ready", "connection_id": challenge.ConnectionID, "binding_revision": binding.Revision, "heartbeat_seconds": 5}) != nil {
		return
	}
	cancel()
	var sequence uint64
	for {
		var heartbeat struct {
			Type         string `json:"type"`
			ConnectionID string `json:"connection_id"`
			Sequence     uint64 `json:"sequence"`
		}
		readCtx, done := context.WithTimeout(connectionCtx, 12*time.Second)
		err = machineRead(readCtx, conn, &heartbeat)
		done()
		if err != nil || heartbeat.Type != "heartbeat" || heartbeat.ConnectionID != challenge.ConnectionID || heartbeat.Sequence != sequence+1 {
			return
		}
		checkCtx, done := context.WithTimeout(connectionCtx, 2*time.Second)
		current, checkErr := s.machines.MachineBinding(checkCtx, binding.ID, binding.Revision)
		done()
		if checkErr != nil || !sameMachineBinding(current, binding) {
			return
		}
		sequence = heartbeat.Sequence
		s.relay.mu.Lock()
		peer.lastSeen = time.Now().UTC()
		s.relay.mu.Unlock()
		if machineWrite(connectionCtx, conn, gin.H{"type": "heartbeat", "connection_id": challenge.ConnectionID, "sequence": sequence}) != nil {
			return
		}
	}
}

func sameMachineBinding(a, b Gateway) bool {
	return a.Active && a.ID == b.ID && a.SpaceID == b.SpaceID && a.LocalSpaceID == b.LocalSpaceID && a.PrincipalID == b.PrincipalID && a.Revision == b.Revision && a.PublicKey == b.PublicKey && strings.Join(a.Scopes, "\n") == strings.Join(b.Scopes, "\n")
}

func (s *Server) machineConnection(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	bindings, err := s.registry.Gateways(c.Request.Context(), session.Principal.ID, c.Param("space"))
	if err != nil {
		result(c, nil, err)
		return
	}
	for _, binding := range bindings {
		if binding.ID == c.Param("gateway") && binding.Active {
			// 列表读取和状态投影之间再次检查当前绑定；存储故障不伪报离线。
			current, err := s.machines.MachineBinding(c.Request.Context(), binding.ID, binding.Revision)
			if err != nil && !errors.Is(err, ErrMissing) {
				result(c, nil, err)
				return
			}
			c.JSON(200, s.relay.view(current))
			return
		}
	}
	fail(c, 404, "not_found")
}
