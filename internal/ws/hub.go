package ws

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/mmrzaf/onlytwo/internal/session"
)

type Config struct {
	AllowedOrigins      []string
	TrustedProxies      []string
	MaxMessageSize      int64
	SendBufferSize      int
	WriteWait           time.Duration
	PongWait            time.Duration
	RateLimitPerMinute  int
	MaxSessionsPerIP    int
	MaxConnectionsPerIP int
}

type RoomInfo struct {
	Code      string `json:"code"`
	ProfileID string `json:"profileId"`
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

func (h *Hub) CreateRoom(profileID, ip string) (RoomInfo, error) {
	s, err := h.registry.CreateSession(profileID, ip, h.cfg.MaxSessionsPerIP)
	if err != nil {
		return RoomInfo{}, err
	}
	return RoomInfo{Code: s.Code, ProfileID: s.ProfileID}, nil
}

func (h *Hub) RoomInfo(code string) (RoomInfo, bool) {
	s, ok := h.registry.GetSession(code)
	if !ok {
		return RoomInfo{}, false
	}
	return RoomInfo{Code: s.Code, ProfileID: s.ProfileID}, true
}

func (h *Hub) ClientIP(r *http.Request) string {
	return ClientIP(r, h.cfg.TrustedProxies)
}

func (h *Hub) AttachConnection(code string, conn *Connection) error {
	s, ok := h.registry.GetSession(code)
	if !ok {
		return session.ErrSessionNotFound
	}
	result, err := s.AddConnection(conn)
	if err != nil {
		return err
	}
	conn.session = s

	if result.Replaced != nil {
		_ = result.Replaced.Close()
	}
	if result.Peer != nil {
		event := relayPeerPresent
		if result.Replaced != nil {
			event = relayPeerRejoined
		}
		_ = sendPriority(result.Peer, relayControlFrame(event))
		_ = conn.SendPriority(relayControlFrame(relayPeerPresent))
	}
	return nil
}

func (h *Hub) DetachConnection(conn *Connection) {
	if conn.session != nil {
		if peer, removed := conn.session.RemoveConnection(conn.SlotToken(), conn.ID()); removed && peer != nil {
			_ = sendPriority(peer, relayControlFrame(relayPeerDisconnected))
		}
	}
	h.releaseIP(conn.ip)
}

func (h *Hub) EndSession(conn *Connection) {
	s := conn.session
	if s == nil || !h.registry.EndSession(s.Code, s) {
		return
	}
	for _, endpoint := range s.DrainConnections() {
		if closable, ok := endpoint.(interface{ CloseWithControl([]byte) error }); ok {
			_ = closable.CloseWithControl(relayControlFrame(relaySessionEnded))
			continue
		}
		_ = endpoint.Close()
	}
}

func sendPriority(endpoint session.ConnEndpoint, msg []byte) error {
	if sender, ok := endpoint.(interface{ SendPriority([]byte) error }); ok {
		return sender.SendPriority(msg)
	}
	return endpoint.Send(msg)
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

func ClientIP(r *http.Request, trustedProxies []string) string {
	remote := remoteHost(r.RemoteAddr)
	if !isTrustedProxy(remote, trustedProxies) {
		return remote
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			ip := strings.TrimSpace(parts[i])
			if net.ParseIP(ip) == nil {
				continue
			}
			if !isTrustedProxy(ip, trustedProxies) {
				return ip
			}
		}
	}
	if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); net.ParseIP(ip) != nil {
		return ip
	}
	return remote
}

func remoteHost(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	return host
}

func isTrustedProxy(ip string, trustedProxies []string) bool {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	for _, entry := range trustedProxies {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if prefix, err := netip.ParsePrefix(entry); err == nil && prefix.Contains(addr) {
			return true
		}
		if exact, err := netip.ParseAddr(entry); err == nil && exact == addr {
			return true
		}
	}
	return false
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
