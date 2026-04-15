package ws

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/mmrzaf/onlytwo/internal/session"
)

const (
	// Time allowed to write a message to the peer.
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer.
	pongWait = 60 * time.Second

	// Send pings to peer with this period. Must be less than pongWait.
	pingPeriod = (pongWait * 9) / 10

	// Maximum message size in bytes (for now, you can tune this).
	maxMessageSize = 64 * 1024
)

// Upgrader config for gorilla.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// NOTE: be strict in production.
	CheckOrigin: func(r *http.Request) bool {
		// TODO: limit allowed origins
		return true
	},
}

type Connection struct {
	id      string
	ws      *websocket.Conn
	hub     *Hub
	session *session.Session

	sendChan chan []byte
}

// Ensure *Connection implements session.ConnEndpoint.
var _ session.ConnEndpoint = (*Connection)(nil)

func newConnection(ws *websocket.Conn, hub *Hub) *Connection {
	return &Connection{
		id:       randomID(),
		ws:       ws,
		hub:      hub,
		sendChan: make(chan []byte, 32),
	}
}

func (c *Connection) ID() string {
	return c.id
}

// Send enqueues data to be written to this connection.
func (c *Connection) Send(msg []byte) error {
	select {
	case c.sendChan <- msg:
		return nil
	default:
		// Backpressure policy: close when buffer is full.
		return errors.New("send buffer full")
	}
}

func (c *Connection) Close() error {
	// signal write loop to exit
	close(c.sendChan)
	return c.ws.Close()
}

// HTTP handler wrapping the upgrade + attach logic.
type Handler struct {
	hub *Hub
}

func NewHandler(hub *Hub) http.Handler {
	return &Handler{hub: hub}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	if code == "" {
		http.Error(w, "missing session code", http.StatusBadRequest)
		return
	}

	wsConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade error: %v", err)
		return
	}

	wsConn.SetReadLimit(maxMessageSize)
	wsConn.SetReadDeadline(time.Now().Add(pongWait))
	wsConn.SetPongHandler(func(string) error {
		// Extend deadline when pong is received.
		wsConn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	conn := newConnection(wsConn, h.hub)

	if err := h.hub.AttachConnection(code, conn); err != nil {
		log.Printf("attach connection failed: %v", err)
		_ = wsConn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "session full or closed"),
			time.Now().Add(writeWait),
		)
		_ = wsConn.Close()
		return
	}

	log.Printf("client connected: session=%s id=%s", code, conn.id)

	// Start write loop in its own goroutine.
	go conn.writeLoop()
	// Run read loop in this goroutine; blocks until connection closes.
	conn.readLoop()

	// Cleanup.
	h.hub.DetachConnection(conn)
	log.Printf("client disconnected: session=%s id=%s", code, conn.id)
}

func (c *Connection) readLoop() {
	defer func() {
		_ = c.ws.Close()
	}()

	for {
		msgType, data, err := c.ws.ReadMessage()
		if err != nil {
			// Normal close or any error: just exit.
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) &&
				!isUnexpectedClose(err) {
				log.Printf("read error (%s): %v", c.id, err)
			}
			return
		}
		// Only binary messages are allowed for OnlyTwo.
		if msgType != websocket.BinaryMessage {
			log.Printf("non-binary message from %s; closing", c.id)
			_ = c.ws.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseUnsupportedData, "binary only"),
				time.Now().Add(writeWait),
			)
			return
		}

		// Relay binary data to peer (raw opaque bytes).
		if c.session == nil {
			continue
		}
		peer := c.session.PeerOf(c.id)
		if peer == nil {
			// No peer yet; drop message.
			continue
		}
		if err := peer.Send(data); err != nil {
			log.Printf("relay error from %s to peer: %v", c.id, err)
		}
	}
}

func (c *Connection) writeLoop() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.ws.Close()
	}()

	for {
		select {
		case msg, ok := <-c.sendChan:
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// Channel closed; send close frame.
				_ = c.ws.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			if err := c.ws.WriteMessage(websocket.BinaryMessage, msg); err != nil {
				if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) &&
					!isUnexpectedClose(err) {
					log.Printf("write error (%s): %v", c.id, err)
				}
				return
			}

		case <-ticker.C:
			// Send ping
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) &&
					!isUnexpectedClose(err) {
					log.Printf("ping error (%s): %v", c.id, err)
				}
				return
			}
		}
	}
}

func randomID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(b[:])
}

func isUnexpectedClose(err error) bool {
	// Treat all other close errors as "normal enough" not to spam logs.
	return !websocket.IsUnexpectedCloseError(err,
		websocket.CloseNormalClosure,
		websocket.CloseGoingAway,
		websocket.CloseNoStatusReceived,
	)
}
