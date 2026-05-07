package ws

import (
	"github.com/mmrzaf/onlytwo/internal/config"
	"github.com/mmrzaf/onlytwo/internal/session"
)

// Hub ties together the session registry and WebSocket handler config.
type Hub struct {
	registry *session.Registry
	cfg      config.Config
}

func NewHub(cfg config.Config) *Hub {
	return &Hub{
		registry: session.NewRegistry(cfg.SessionTTL),
		cfg:      cfg,
	}
}

// Registry exposes the session registry (used by main for cleanup goroutine).
func (h *Hub) Registry() *session.Registry {
	return h.registry
}

// AttachConnection assigns a WebSocket connection to a session, creating the
// session if necessary. Returns an error if the session is full or expired.
func (h *Hub) AttachConnection(code string, c *Connection) error {
	s := h.registry.GetOrCreateSession(code)
	if err := s.AddConnection(c); err != nil {
		return err
	}
	c.session = s
	return nil
}

// DetachConnection removes a connection from its session. If the session is
// now empty and expired, it is also removed from the registry.
func (h *Hub) DetachConnection(c *Connection) {
	s := c.session
	if s == nil {
		return
	}
	s.RemoveConnection(c.id)
	if !s.HasConnections() && s.IsExpired() {
		h.registry.RemoveSession(s.Code)
	}
}
