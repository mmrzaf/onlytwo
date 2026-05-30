package ws

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mmrzaf/onlytwo/internal/session"
)

func TestClientIPIgnoresForwardedHeadersFromUntrustedPeer(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "203.0.113.10:1234"
	r.Header.Set("X-Forwarded-For", "198.51.100.7")
	if got := ClientIP(r, nil); got != "203.0.113.10" {
		t.Fatalf("unexpected IP %q", got)
	}
}

func TestClientIPUsesForwardedHeaderFromTrustedProxy(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("X-Forwarded-For", "198.51.100.7")
	if got := ClientIP(r, []string{"127.0.0.1"}); got != "198.51.100.7" {
		t.Fatalf("unexpected IP %q", got)
	}
}

func TestClientIPRejectsSpoofedLeftmostForwardedValue(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("X-Forwarded-For", "198.51.100.99, 203.0.113.7")
	if got := ClientIP(r, []string{"127.0.0.1"}); got != "203.0.113.7" {
		t.Fatalf("unexpected IP %q", got)
	}
}

func TestAttachConnectionRejectsMissingRoom(t *testing.T) {
	hub := NewHub(session.NewRegistry(time.Minute), Config{})
	conn := &Connection{id: "conn", slotToken: "0123456789abcdef0123456789abcdef"}
	if err := hub.AttachConnection("ABCD-2345", conn); err != session.ErrSessionNotFound {
		t.Fatalf("expected missing room error, got %v", err)
	}
}
