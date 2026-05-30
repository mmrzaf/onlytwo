package session

import (
	"errors"
	"sync"
	"time"
)

var (
	ErrSessionFull     = errors.New("session already has two participants")
	ErrSessionClosed   = errors.New("session is closed or expired")
	ErrSessionNotFound = errors.New("session not found")
	ErrSessionExists   = errors.New("session code already exists")
	ErrInvalidProfile  = errors.New("invalid transport profile")
	ErrTooManySessions = errors.New("too many active sessions")
)

var validProfileIDs = map[string]struct{}{
	"balanced":        {},
	"low_data":        {},
	"voice_first":     {},
	"maximum_privacy": {},
}

func ValidProfileID(profileID string) bool {
	_, ok := validProfileIDs[profileID]
	return ok
}

type ConnEndpoint interface {
	ID() string
	SlotToken() string
	RemoteAddr() string
	Send(msg []byte) error
	Close() error
}

type AddResult struct {
	Peer     ConnEndpoint
	Replaced ConnEndpoint
}

type Session struct {
	Code      string
	ProfileID string
	CreatorIP string
	CreatedAt time.Time
	ExpiresAt time.Time

	mu     sync.RWMutex
	ttl    time.Duration
	closed bool
	conns  map[string]ConnEndpoint
}

func NewSession(code, profileID, creatorIP string, ttl time.Duration) *Session {
	now := time.Now().UTC()
	return &Session{
		Code:      code,
		ProfileID: profileID,
		CreatorIP: creatorIP,
		CreatedAt: now,
		ExpiresAt: now.Add(ttl),
		ttl:       ttl,
		conns:     make(map[string]ConnEndpoint, 2),
	}
}

func (s *Session) IsExpired() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.expiredLocked(time.Now().UTC())
}

func (s *Session) AddConnection(conn ConnEndpoint) (AddResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.expiredLocked(time.Now().UTC()) {
		return AddResult{}, ErrSessionClosed
	}
	slot := conn.SlotToken()
	if slot == "" {
		return AddResult{}, ErrSessionClosed
	}

	result := AddResult{}
	if old, ok := s.conns[slot]; ok {
		result.Replaced = old
	} else if len(s.conns) >= 2 {
		return AddResult{}, ErrSessionFull
	}
	s.conns[slot] = conn
	// Connected rooms stay alive. The idle TTL starts again once the last socket detaches.
	s.ExpiresAt = time.Time{}
	for otherSlot, other := range s.conns {
		if otherSlot != slot {
			result.Peer = other
			break
		}
	}
	return result, nil
}

func (s *Session) RemoveConnection(slotToken, connID string) (ConnEndpoint, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.conns[slotToken]
	if !ok || current.ID() != connID {
		return nil, false
	}
	delete(s.conns, slotToken)
	if len(s.conns) == 0 {
		s.ExpiresAt = time.Now().UTC().Add(s.ttl)
	}
	for _, peer := range s.conns {
		return peer, true
	}
	return nil, true
}

func (s *Session) PeerOf(connID string) ConnEndpoint {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed || s.expiredLocked(time.Now().UTC()) {
		return nil
	}
	for _, conn := range s.conns {
		if conn.ID() != connID {
			return conn
		}
	}
	return nil
}

func (s *Session) Connections() []ConnEndpoint {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ConnEndpoint, 0, len(s.conns))
	for _, conn := range s.conns {
		out = append(out, conn)
	}
	return out
}

func (s *Session) HasConnections() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.conns) > 0
}

func (s *Session) DrainConnections() []ConnEndpoint {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	conns := make([]ConnEndpoint, 0, len(s.conns))
	for _, conn := range s.conns {
		conns = append(conns, conn)
	}
	s.conns = make(map[string]ConnEndpoint)
	s.mu.Unlock()
	return conns
}

func (s *Session) Close() {
	for _, conn := range s.DrainConnections() {
		_ = conn.Close()
	}
}

func (s *Session) expiredLocked(now time.Time) bool {
	return len(s.conns) == 0 && !s.ExpiresAt.IsZero() && !now.Before(s.ExpiresAt)
}
