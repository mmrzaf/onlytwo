package ws

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/mmrzaf/onlytwo/internal/session"
)

type Config struct {
	AllowedOrigins      []string
	MaxMessageSize      int64
	SendBufferSize      int
	WriteWait           time.Duration
	PongWait            time.Duration
	RateLimitPerMinute  int
	MaxSessionsPerIP    int
	MaxConnectionsPerIP int
}

type Hub struct {
	registry *session.Registry
	cfg      Config
	limiter  *RateLimiter

	mu        sync.Mutex
	connsByIP map[string]int
}

func NewHub(registry *session.Registry, cfg Config) *Hub {
	if cfg.MaxMessageSize <= 0 {
		cfg.MaxMessageSize = 256 * 1024
	}
	if cfg.SendBufferSize <= 0 {
		cfg.SendBufferSize = 128
	}
	if cfg.WriteWait <= 0 {
		cfg.WriteWait = 10 * time.Second
	}
	if cfg.PongWait <= 0 {
		cfg.PongWait = 60 * time.Second
	}
	return &Hub{registry: registry, cfg: cfg, limiter: NewRateLimiter(cfg.RateLimitPerMinute), connsByIP: make(map[string]int)}
}

func (h *Hub) AttachConnection(code string, conn *Connection) error {
	s, ok := h.registry.GetOrCreateSession(code)
	if !ok {
		return session.ErrSessionClosed
	}
	if err := s.AddConnection(conn); err != nil {
		return err
	}
	conn.session = s
	return nil
}

func (h *Hub) DetachConnection(conn *Connection) {
	if conn.session != nil {
		conn.session.RemoveConnection(conn.ID())
	}
	h.releaseIP(conn.ip)
}

func (h *Hub) allowOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	for _, allowed := range h.cfg.AllowedOrigins {
		if allowed == "*" || strings.EqualFold(strings.TrimSpace(allowed), origin) {
			return true
		}
	}
	return false
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if ip := strings.TrimSpace(parts[0]); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (h *Hub) reserveIP(ip string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.cfg.MaxConnectionsPerIP > 0 && h.connsByIP[ip] >= h.cfg.MaxConnectionsPerIP {
		return false
	}
	h.connsByIP[ip]++
	return true
}

func (h *Hub) releaseIP(ip string) {
	if ip == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.connsByIP[ip] <= 1 {
		delete(h.connsByIP, ip)
		return
	}
	h.connsByIP[ip]--
}
