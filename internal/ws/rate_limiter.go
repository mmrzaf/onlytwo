package ws

import (
	"sync"
	"time"
)

type rateWindow struct {
	count     int
	startedAt time.Time
}

type RateLimiter struct {
	mu      sync.Mutex
	limit   int
	windows map[string]rateWindow
}

func NewRateLimiter(limitPerMinute int) *RateLimiter {
	return &RateLimiter{limit: limitPerMinute, windows: make(map[string]rateWindow)}
}

func (r *RateLimiter) Allow(key string) bool {
	if r.limit <= 0 {
		return true
	}
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()
	w := r.windows[key]
	if w.startedAt.IsZero() || now.Sub(w.startedAt) >= time.Minute {
		r.windows[key] = rateWindow{count: 1, startedAt: now}
		return true
	}
	if w.count >= r.limit {
		return false
	}
	w.count++
	r.windows[key] = w
	return true
}

func (r *RateLimiter) Sweep() {
	cutoff := time.Now().Add(-2 * time.Minute)
	r.mu.Lock()
	defer r.mu.Unlock()
	for key, w := range r.windows {
		if w.startedAt.Before(cutoff) {
			delete(r.windows, key)
		}
	}
}
