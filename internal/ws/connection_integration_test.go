package ws

import (
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/mmrzaf/onlytwo/internal/config"
)

func TestWebsocketRelay(t *testing.T) {
	hub := NewHub(config.Config{
		SessionTTL: 60,
	})

	server := httptest.NewServer(NewHandler(hub))
	defer server.Close()

	u, _ := url.Parse(server.URL)
	u.Scheme = "ws"

	ws1, _, err := websocket.DefaultDialer.Dial(u.String()+"?code=test", nil)
	if err != nil {
		t.Fatalf("dial1 failed: %v", err)
	}
	defer ws1.Close()

	ws2, _, err := websocket.DefaultDialer.Dial(u.String()+"?code=test", nil)
	if err != nil {
		t.Fatalf("dial2 failed: %v", err)
	}
	defer ws2.Close()

	payload := []byte("hello")

	if err := ws1.WriteMessage(websocket.BinaryMessage, payload); err != nil {
		t.Fatalf("write failed: %v", err)
	}

	_ = ws2.SetReadDeadline(time.Now().Add(2 * time.Second))

	typ, msg, err := ws2.ReadMessage()
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}

	if typ != websocket.BinaryMessage {
		t.Fatalf("expected binary message")
	}

	if string(msg) != "hello" {
		t.Fatalf("unexpected payload: %s", string(msg))
	}
}
