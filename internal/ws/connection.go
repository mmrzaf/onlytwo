package ws

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/mmrzaf/onlytwo/internal/session"
)

const (
	// writeWait is the maximum time allowed to write a frame to the peer.
	writeWait = 10 * time.Second

	// pongWait is the maximum time to wait for a pong reply to a ping.
	pongWait = 60 * time.Second

	// pingPeriod is how often we send a ping. Must be less than pongWait.
	pingPeriod = (pongWait * 9) / 10

	// maxMessageSize is the maximum binary frame size we will accept.
	// 72 KiB accommodates a 64 KiB file chunk + AES-GCM tag + protocol
	// header (29 bytes) with a generous margin.
	maxMessageSize = 72 * 1024

	// sendBufferSize is the capacity of the per-connection send channel.
	// Larger values absorb short bursts without back-pressure.
	sendBufferSize = 64
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// Connection represents a single WebSocket client.
// It implements session.ConnEndpoint.
type Connection struct {
	id      string
	ws      *websocket.Conn
	hub     *Hub
	session *session.Session

	sendChan  chan []byte
	closeOnce sync.Once
	ctx       context.Context
	cancel    context.CancelFunc
}

var _ session.ConnEndpoint = (*Connection)(nil)

func newConnection(ws *websocket.Conn, hub *Hub) *Connection {
	ctx, cancel := context.WithCancel(context.Background())
	return &Connection{
		id:       randomID(),
		ws:       ws,
		hub:      hub,
		sendChan: make(chan []byte, sendBufferSize),
		ctx:      ctx,
		cancel:   cancel,
	}
}

// ID returns the unique identifier for this connection.
func (c *Connection) ID() string { return c.id }

// Send enqueues a binary message for delivery to this connection.
// It blocks until there is space in the send buffer or until the
// connection context is cancelled (preventing deadlocks).
func (c *Connection) Send(msg []byte) error {
	select {
	case c.sendChan <- msg:
		return nil
	case <-c.ctx.Done():
		return errors.New("connection closed")
	}
}

// Close shuts down the connection exactly once (safe to call from multiple
// goroutines). It cancels the context, drains the send channel, and closes
// the underlying WebSocket.
func (c *Connection) Close() error {
	c.closeOnce.Do(func() {
		c.cancel()
		close(c.sendChan)
		_ = c.ws.Close()
	})
	return nil
}

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
		log.Printf("[ws] upgrade error: %v", err)
		return
	}

	wsConn.SetReadLimit(maxMessageSize)
	_ = wsConn.SetReadDeadline(time.Now().Add(pongWait))
	wsConn.SetPongHandler(func(string) error {
		return wsConn.SetReadDeadline(time.Now().Add(pongWait))
	})

	conn := newConnection(wsConn, h.hub)

	if err := h.hub.AttachConnection(code, conn); err != nil {
		log.Printf("[ws] attach failed (session=%s): %v", code, err)
		_ = wsConn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "session full or closed"),
			time.Now().Add(writeWait),
		)
		_ = wsConn.Close()
		return
	}

	log.Printf("[ws] connected  session=%s id=%s", code, conn.id)

	go conn.writeLoop()
	conn.readLoop() // blocks until the connection dies

	h.hub.DetachConnection(conn)
	log.Printf("[ws] disconnected session=%s id=%s", code, conn.id)
}

func (c *Connection) readLoop() {
	defer c.Close()

	for {
		msgType, data, err := c.ws.ReadMessage()
		if err != nil {
			if !isNormalClose(err) {
				log.Printf("[ws] read error (id=%s): %v", c.id, err)
			}
			return
		}

		if msgType != websocket.BinaryMessage {
			log.Printf("[ws] non-binary frame from %s — closing", c.id)
			_ = c.ws.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(
					websocket.CloseUnsupportedData, "binary only",
				),
				time.Now().Add(writeWait),
			)
			return
		}

		if c.session == nil {
			continue
		}

		peer := c.session.PeerOf(c.id)
		if peer == nil {
			continue
		}

		if err := peer.Send(data); err != nil {
			log.Printf("[ws] relay error %s→peer: %v", c.id, err)
		}
	}
}

func (c *Connection) writeLoop() {
	defer c.Close()

	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	for {
		select {
		case msg, ok := <-c.sendChan:
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.ws.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.ws.WriteMessage(websocket.BinaryMessage, msg); err != nil {
				if !isNormalClose(err) {
					log.Printf("[ws] write error (id=%s): %v", c.id, err)
				}
				return
			}

		case <-ticker.C:
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				if !isNormalClose(err) {
					log.Printf("[ws] ping error (id=%s): %v", c.id, err)
				}
				return
			}

		case <-c.ctx.Done():
			return
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

// isNormalClose returns true if the error represents an ordinary connection
// teardown that does not require logging.
func isNormalClose(err error) bool {
	return websocket.IsCloseError(
		err,
		websocket.CloseNormalClosure,
		websocket.CloseGoingAway,
		websocket.CloseNoStatusReceived,
	)
}
