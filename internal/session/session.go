package session

import (
	"errors"
	"sync"
	"time"
)

var (
	ErrSessionFull   = errors.New("session already has two participants")
	ErrSessionClosed = errors.New("session is closed or expired")
)

type ConnEndpoint interface {
	ID() string
	RemoteAddr() string
	Send(msg []byte) error
	Close() error
}

type Session struct {
	Code      string
	CreatedAt time.Time
	ExpiresAt time.Time

	mu     sync.RWMutex
	closed bool
	conns  map[string]ConnEndpoint
}

func NewSession(code string, ttl time.Duration) *Session {
	now := time.Now().UTC()
	return &Session{Code: code, CreatedAt: now, ExpiresAt: now.Add(ttl), conns: make(map[string]ConnEndpoint, 2)}
}

func (s *Session) IsExpired() bool {
	return time.Now().UTC().After(s.ExpiresAt)
}

func (s *Session) AddConnection(conn ConnEndpoint) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.IsExpired() {
		return ErrSessionClosed
	}
	if len(s.conns) >= 2 {
		return ErrSessionFull
	}
	s.conns[conn.ID()] = conn
	return nil
}

func (s *Session) RemoveConnection(connID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.conns, connID)
}

func (s *Session) PeerOf(connID string) ConnEndpoint {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed || s.IsExpired() {
		return nil
	}
	for id, c := range s.conns {
		if id != connID {
			return c
		}
	}
	return nil
}

func (s *Session) HasConnections() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.conns) > 0
}

func (s *Session) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	conns := make([]ConnEndpoint, 0, len(s.conns))
	for _, c := range s.conns {
		conns = append(conns, c)
	}
	s.conns = make(map[string]ConnEndpoint)
	s.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}
