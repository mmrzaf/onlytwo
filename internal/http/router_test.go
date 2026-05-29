package http

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mmrzaf/onlytwo/internal/config"
	"github.com/mmrzaf/onlytwo/internal/session"
	"github.com/mmrzaf/onlytwo/internal/ws"
)

func TestRouterHealthAndHeaders(t *testing.T) {
	cfg := config.Config{ContentSecurityPolicy: "default-src 'self'", SessionTTL: time.Minute, MaxFrameBytes: 1024, SendBufferSize: 8, WriteWait: time.Second, PongWait: time.Second}
	hub := ws.NewHub(session.NewRegistry(time.Minute), ws.Config{MaxMessageSize: 1024, SendBufferSize: 8, WriteWait: time.Second, PongWait: time.Second})
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	NewRouter(hub, cfg).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "ok") {
		t.Fatal("missing ok")
	}
	if rec.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("missing CSP")
	}
}
