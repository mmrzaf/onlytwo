package http_test

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/mmrzaf/onlytwo/internal/config"
	onlytwoHttp "github.com/mmrzaf/onlytwo/internal/http"
	ws2 "github.com/mmrzaf/onlytwo/internal/ws"
)

func TestWebSocketRelay(t *testing.T) {
	cfg := config.Config{SessionTTL: 60}
	hub := ws2.NewHub(cfg)
	handler := onlytwoHttp.NewRouter(hub, cfg)
	srv := httptest.NewServer(handler)
	defer srv.Close()

	wsURL := "ws" + srv.URL[4:] + "/ws?code=relaytest"

	conn1, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial1: %v", err)
	}
	defer conn1.Close()

	conn2, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial2: %v", err)
	}
	defer conn2.Close()

	msg := []byte("hello from peer1")
	if err := conn1.WriteMessage(websocket.BinaryMessage, msg); err != nil {
		t.Fatalf("write: %v", err)
	}

	_ = conn2.SetReadDeadline(time.Now().Add(2 * time.Second))
	mt, data, err := conn2.ReadMessage()
	if err != nil {
		t.Fatalf("read peer2: %v", err)
	}
	if mt != websocket.BinaryMessage {
		t.Errorf("expected binary message, got %d", mt)
	}
	if string(data) != string(msg) {
		t.Errorf("expected %q, got %q", msg, data)
	}

	conn3, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err == nil {
		_, _, err := conn3.ReadMessage()
		if err == nil {
			t.Error("third connection should have been rejected")
		}
		conn3.Close()
	}
}
