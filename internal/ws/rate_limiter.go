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
	mu        sync.Mutex
	limit     int
	windows   map[string]rateWindow
	lastSweep time.Time
}

func NewRateLimiter(limitPerMinute int) *RateLimiter {
	return &RateLimiter{limit: limitPerMinute, windows: make(map[string]rateWindow), lastSweep: time.Now()}
}

func (r *RateLimiter) Allow(key string) bool {
	if r.limit <= 0 {
		return true
	}
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sweepLocked(now)
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
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sweepLocked(now)
}

func (r *RateLimiter) sweepLocked(now time.Time) {
	if !r.lastSweep.IsZero() && now.Sub(r.lastSweep) < time.Minute {
		return
	}
	cutoff := now.Add(-2 * time.Minute)
	for key, w := range r.windows {
		if w.startedAt.Before(cutoff) {
			delete(r.windows, key)
		}
	}
	r.lastSweep = now
}
