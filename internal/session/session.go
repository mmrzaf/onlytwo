package session

import (
	"sync"
	"time"
)

// Session represents a two-party relay session.
// It is identified by a human-readable session code (e.g. AX72-FE9K).
type Session struct {
	Code      string
	CreatedAt time.Time
	ExpiresAt time.Time

	mu    sync.RWMutex
	conns map[string]ConnEndpoint // connectionID -> endpoint
}

// ConnEndpoint is the interface the ws layer must implement to allow
// sending raw binary frames to the peer.
type ConnEndpoint interface {
	ID() string
	Send(msg []byte) error
	Close() error
}

// NewSession creates a session with the given code and TTL in seconds.
func NewSession(code string, ttlSeconds int64) *Session {
	now := time.Now().UTC()
	return &Session{
		Code:      code,
		CreatedAt: now,
		ExpiresAt: now.Add(time.Duration(ttlSeconds) * time.Second),
		conns:     make(map[string]ConnEndpoint, 2),
	}
}

// IsExpired checks whether the session should be cleaned up.
func (s *Session) IsExpired() bool {
	return time.Now().UTC().After(s.ExpiresAt)
}

// AddConnection adds a connection to the session.
// Returns error if there are already 2 participants.
func (s *Session) AddConnection(conn ConnEndpoint) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.conns) >= 2 {
		return ErrSessionFull
	}
	s.conns[conn.ID()] = conn
	return nil
}

// RemoveConnection removes a connection from the session.
func (s *Session) RemoveConnection(connID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.conns, connID)
}

// PeerOf returns the "other" connection in the session, if any.
func (s *Session) PeerOf(connID string) ConnEndpoint {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if len(s.conns) < 2 {
		return nil
	}
	for id, c := range s.conns {
		if id != connID {
			return c
		}
	}
	return nil
}

// HasConnections returns whether session still has any live connections.
func (s *Session) HasConnections() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.conns) > 0
}
