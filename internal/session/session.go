package session

import (
	"sync"
	"time"
)

// Session represents a two-party relay session identified by a session code.
type Session struct {
	Code      string
	CreatedAt time.Time
	ExpiresAt time.Time

	mu    sync.RWMutex
	conns map[string]ConnEndpoint // max 2
}

// ConnEndpoint is the interface the ws layer must satisfy so the session
// can deliver messages to a peer without knowing anything about WebSocket.
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

// IsExpired reports whether this session has passed its TTL.
func (s *Session) IsExpired() bool {
	return time.Now().UTC().After(s.ExpiresAt)
}

// AddConnection attaches a connection to the session.
// Returns ErrSessionFull if there are already 2 participants.
func (s *Session) AddConnection(conn ConnEndpoint) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.conns) >= 2 {
		return ErrSessionFull
	}
	s.conns[conn.ID()] = conn
	return nil
}

// RemoveConnection detaches a connection from the session.
func (s *Session) RemoveConnection(connID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.conns, connID)
}

// PeerOf returns the other connection in the session, or nil if there is none.
func (s *Session) PeerOf(connID string) ConnEndpoint {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for id, c := range s.conns {
		if id != connID {
			return c
		}
	}
	return nil
}

// HasConnections reports whether at least one connection is still attached.
func (s *Session) HasConnections() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.conns) > 0
}
