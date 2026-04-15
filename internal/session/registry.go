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

// GetOrCreateSession returns an existing non-expired session or creates a new one.
func (r *Registry) GetOrCreateSession(code string) *Session {
	r.mu.Lock()
	defer r.mu.Unlock()

	s, ok := r.sessions[code]
	if ok && !s.IsExpired() {
		return s
	}

	s = NewSession(code, r.ttl)
	r.sessions[code] = s
	return s
}

// GetSession returns session if exists and not expired.
func (r *Registry) GetSession(code string) (*Session, bool) {
	r.mu.RLock()
	s, ok := r.sessions[code]
	r.mu.RUnlock()
	if !ok || s.IsExpired() {
		return nil, false
	}
	return s, true
}

// RemoveSession removes a session from registry.
func (r *Registry) RemoveSession(code string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, code)
}

// CleanupExpired removes expired or empty sessions periodically.
// Call this from a background goroutine.
func (r *Registry) CleanupExpired(interval time.Duration, stopCh <-chan struct{}) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			now := time.Now().UTC()
			r.mu.Lock()
			for code, s := range r.sessions {
				if s.IsExpired() || (!s.HasConnections() && now.After(s.ExpiresAt)) {
					delete(r.sessions, code)
				}
			}
			r.mu.Unlock()
		case <-stopCh:
			return
		}
	}
}
