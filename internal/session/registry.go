package session

import (
	"regexp"
	"sync"
	"time"
)

var codePattern = regexp.MustCompile(`^[A-Z0-9]{4}-[A-Z0-9]{4}$`)

type Registry struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	ttl      time.Duration
}

func NewRegistry(ttl time.Duration) *Registry {
	return &Registry{sessions: make(map[string]*Session), ttl: ttl}
}

func ValidCode(code string) bool {
	return codePattern.MatchString(code)
}

func (r *Registry) GetOrCreateSession(code string) (*Session, bool) {
	if !ValidCode(code) {
		return nil, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if s, ok := r.sessions[code]; ok && !s.IsExpired() {
		return s, true
	}
	s := NewSession(code, r.ttl)
	r.sessions[code] = s
	return s, true
}

func (r *Registry) GetSession(code string) (*Session, bool) {
	r.mu.RLock()
	s, ok := r.sessions[code]
	r.mu.RUnlock()
	if !ok || s.IsExpired() {
		return nil, false
	}
	return s, true
}

func (r *Registry) RemoveSession(code string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, code)
}

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
	var closing []*Session
	r.mu.Lock()
	for code, s := range r.sessions {
		if s.IsExpired() || (!s.HasConnections() && now.After(s.ExpiresAt)) {
			delete(r.sessions, code)
			closing = append(closing, s)
		}
	}
	r.mu.Unlock()
	for _, s := range closing {
		s.Close()
	}
}
