package ws

import (
	"testing"
	"time"
)

func TestRateLimiterAllowSweepsExpiredWindows(t *testing.T) {
	limiter := NewRateLimiter(10)
	limiter.windows["stale"] = rateWindow{count: 1, startedAt: time.Now().Add(-3 * time.Minute)}
	limiter.lastSweep = time.Now().Add(-2 * time.Minute)
	if !limiter.Allow("fresh") {
		t.Fatal("expected fresh key to be allowed")
	}
	if _, ok := limiter.windows["stale"]; ok {
		t.Fatal("expected stale window to be swept")
	}
}
