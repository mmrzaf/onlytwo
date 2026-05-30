package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mmrzaf/onlytwo/internal/config"
	"github.com/mmrzaf/onlytwo/internal/session"
	"github.com/mmrzaf/onlytwo/internal/ws"
)

func testRouter() http.Handler {
	cfg := config.Config{ContentSecurityPolicy: "default-src 'self'", SessionTTL: time.Minute, MaxFrameBytes: 1024, SendBufferSize: 8, WriteWait: time.Second, PongWait: time.Second}
	hub := ws.NewHub(session.NewRegistry(time.Minute), ws.Config{MaxMessageSize: 1024, SendBufferSize: 8, WriteWait: time.Second, PongWait: time.Second, MaxSessionsPerIP: 8})
	return NewRouter(hub, cfg)
}

func TestRouterHealthAndHeaders(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	testRouter().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "ok") {
		t.Fatalf("unexpected health response: %d %q", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("missing CSP")
	}
	if rec.Header().Get("Permissions-Policy") != "microphone=(self)" {
		t.Fatal("missing microphone permissions policy")
	}
}

func TestRoomsAPIExplicitCreateAndLookup(t *testing.T) {
	router := testRouter()
	create := httptest.NewRequest(http.MethodPost, "/api/rooms", strings.NewReader(`{"profileId":"voice_first"}`))
	create.Header.Set("Content-Type", "application/json")
	created := httptest.NewRecorder()
	router.ServeHTTP(created, create)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status %d body=%q", created.Code, created.Body.String())
	}
	var room ws.RoomInfo
	if err := json.Unmarshal(created.Body.Bytes(), &room); err != nil {
		t.Fatal(err)
	}
	if room.Code == "" || room.ProfileID != "voice_first" {
		t.Fatalf("unexpected room %+v", room)
	}
	lookup := httptest.NewRequest(http.MethodGet, "/api/rooms/"+room.Code, nil)
	found := httptest.NewRecorder()
	router.ServeHTTP(found, lookup)
	if found.Code != http.StatusOK || !strings.Contains(found.Body.String(), `"profileId":"voice_first"`) {
		t.Fatalf("lookup status %d body=%q", found.Code, found.Body.String())
	}
	if found.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("room responses must not be cached")
	}
}

func TestRoomsAPIMissingRoomDoesNotCreate(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/rooms/ABCD-1234", nil)
	rec := httptest.NewRecorder()
	testRouter().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected missing room, got %d", rec.Code)
	}
}

func TestRoomsAPIRejectsInvalidProfile(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/rooms", strings.NewReader(`{"profileId":"unknown"}`))
	rec := httptest.NewRecorder()
	testRouter().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request, got %d", rec.Code)
	}
}
