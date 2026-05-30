package session

import (
	"crypto/rand"
	"regexp"
	"sync"
	"time"
)

var codePattern = regexp.MustCompile(`^[A-Z0-9]{4}-[A-Z0-9]{4}$`)

const roomAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

type Registry struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	ended    map[string]time.Time
	ttl      time.Duration
}

func NewRegistry(ttl time.Duration) *Registry {
	return &Registry{sessions: make(map[string]*Session), ended: make(map[string]time.Time), ttl: ttl}
}

func ValidCode(code string) bool { return codePattern.MatchString(code) }

func (r *Registry) CreateSession(profileID, creatorIP string, maxSessionsPerIP int) (*Session, error) {
	if !ValidProfileID(profileID) {
		return nil, ErrInvalidProfile
	}
	for attempts := 0; attempts < 64; attempts++ {
		code, err := randomRoomCode()
		if err != nil {
			return nil, err
		}
		s, err := r.CreateSessionWithCode(code, profileID, creatorIP, maxSessionsPerIP)
		if err == ErrSessionExists {
			continue
		}
		return s, err
	}
	return nil, ErrSessionExists
}

func (r *Registry) CreateSessionWithCode(code, profileID, creatorIP string, maxSessionsPerIP int) (*Session, error) {
	if !ValidCode(code) {
		return nil, ErrSessionNotFound
	}
	if !ValidProfileID(profileID) {
		return nil, ErrInvalidProfile
	}
	now := time.Now().UTC()
	var closing []*Session

	r.mu.Lock()
	for existingCode, current := range r.sessions {
		if current.IsExpired() {
			delete(r.sessions, existingCode)
			closing = append(closing, current)
		}
	}
	if expiresAt, ended := r.ended[code]; ended {
		if now.Before(expiresAt) {
			r.mu.Unlock()
			closeSessions(closing)
			return nil, ErrSessionExists
		}
		delete(r.ended, code)
	}
	if _, exists := r.sessions[code]; exists {
		r.mu.Unlock()
		closeSessions(closing)
		return nil, ErrSessionExists
	}
	if maxSessionsPerIP > 0 && creatorIP != "" {
		count := 0
		for _, current := range r.sessions {
			if current.CreatorIP == creatorIP {
				count++
			}
		}
		if count >= maxSessionsPerIP {
			r.mu.Unlock()
			closeSessions(closing)
			return nil, ErrTooManySessions
		}
	}
	s := NewSession(code, profileID, creatorIP, r.ttl)
	r.sessions[code] = s
	r.mu.Unlock()
	closeSessions(closing)
	return s, nil
}

func (r *Registry) GetSession(code string) (*Session, bool) {
	if !ValidCode(code) {
		return nil, false
	}
	r.mu.RLock()
	s, ok := r.sessions[code]
	r.mu.RUnlock()
	if !ok {
		return nil, false
	}
	if s.IsExpired() {
		r.RemoveSession(code, s)
		go s.Close()
		return nil, false
	}
	return s, true
}

func (r *Registry) EndSession(code string, expected *Session) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	current, ok := r.sessions[code]
	if !ok || current != expected {
		return false
	}
	delete(r.sessions, code)
	r.ended[code] = time.Now().UTC().Add(r.ttl)
	return true
}

func (r *Registry) RemoveSession(code string, expected *Session) {
	r.mu.Lock()
	defer r.mu.Unlock()
	current, ok := r.sessions[code]
	if ok && (expected == nil || current == expected) {
		delete(r.sessions, code)
	}
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
		if s.IsExpired() {
			delete(r.sessions, code)
			closing = append(closing, s)
		}
	}
	for code, expiresAt := range r.ended {
		if !now.Before(expiresAt) {
			delete(r.ended, code)
		}
	}
	r.mu.Unlock()
	closeSessions(closing)
}

func closeSessions(sessions []*Session) {
	for _, s := range sessions {
		s.Close()
	}
}

func randomRoomCode() (string, error) {
	var bytes [8]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	var raw [8]byte
	for i, value := range bytes {
		raw[i] = roomAlphabet[int(value)%len(roomAlphabet)]
	}
	return string(raw[:4]) + "-" + string(raw[4:]), nil
}
