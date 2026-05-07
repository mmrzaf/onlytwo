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

// Registry holds all active sessions in memory.
type Registry struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	ttl      int64 // seconds
}

func NewRegistry(ttlSeconds int64) *Registry {
	return &Registry{
		sessions: make(map[string]*Session),
		ttl:      ttlSeconds,
	}
}

// GetOrCreateSession returns an existing, non-expired session for the given
// code, or creates a new one if none exists (or the existing one is expired).
func (r *Registry) GetOrCreateSession(code string) *Session {
	r.mu.Lock()
	defer r.mu.Unlock()

	if s, ok := r.sessions[code]; ok && !s.IsExpired() {
		return s
	}
	s := NewSession(code, r.ttl)
	r.sessions[code] = s
	return s
}

// GetSession returns the session for code if it exists and has not expired.
func (r *Registry) GetSession(code string) (*Session, bool) {
	r.mu.RLock()
	s, ok := r.sessions[code]
	r.mu.RUnlock()

	if !ok || s.IsExpired() {
		return nil, false
	}
	return s, true
}

// RemoveSession deletes a session from the registry.
func (r *Registry) RemoveSession(code string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, code)
}

// CleanupExpired periodically removes sessions that have expired or are empty
// past their TTL. Stops when stopCh is closed.
func (r *Registry) CleanupExpired(interval time.Duration, stopCh <-chan struct{}) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			r.sweepExpired()
		case <-stopCh:
			return
		}
	}
}

func (r *Registry) sweepExpired() {
	now := time.Now().UTC()
	r.mu.Lock()
	defer r.mu.Unlock()

	for code, s := range r.sessions {
		if s.IsExpired() || (!s.HasConnections() && now.After(s.ExpiresAt)) {
			delete(r.sessions, code)
		}
	}
}
