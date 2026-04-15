package ws

import (
	"github.com/mmrzaf/onlytwo/internal/config"
	"github.com/mmrzaf/onlytwo/internal/session"
)

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

func (h *Hub) Registry() *session.Registry {
	return h.registry
}

func (h *Hub) AttachConnection(code string, c *Connection) error {
	s := h.registry.GetOrCreateSession(code)

	if err := s.AddConnection(c); err != nil {
		return err
	}

	c.session = s
	return nil
}

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
