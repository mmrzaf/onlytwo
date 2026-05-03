package ws

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/mmrzaf/onlytwo/internal/session"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 72 * 1024
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type Connection struct {
	id      string
	ws      *websocket.Conn
	hub     *Hub
	session *session.Session

	sendChan chan []byte

	// backpressure control
	pauseRead  chan struct{}
	resumeRead chan struct{}
}

var _ session.ConnEndpoint = (*Connection)(nil)

func newConnection(ws *websocket.Conn, hub *Hub) *Connection {
	return &Connection{
		id:         randomID(),
		ws:         ws,
		hub:        hub,
		sendChan:   make(chan []byte, 32),
		pauseRead:  make(chan struct{}, 1),
		resumeRead: make(chan struct{}, 1),
	}
}

func (c *Connection) ID() string {
	return c.id
}

func (c *Connection) Send(msg []byte) error {
	select {
	case c.sendChan <- msg:
		return nil
	default:
		// signal peer to pause reading
		select {
		case c.pauseRead <- struct{}{}:
		default:
		}

		// block until space exists (true backpressure)
		c.sendChan <- msg
		return nil
	}
}

func (c *Connection) Close() error {
	close(c.sendChan)
	return c.ws.Close()
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
		log.Printf("websocket upgrade error: %v", err)
		return
	}

	wsConn.SetReadLimit(maxMessageSize)
	wsConn.SetReadDeadline(time.Now().Add(pongWait))
	wsConn.SetPongHandler(func(string) error {
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

	go conn.writeLoop()
	conn.readLoop()

	h.hub.DetachConnection(conn)

	log.Printf("client disconnected: session=%s id=%s", code, conn.id)
}

func (c *Connection) readLoop() {
	defer c.ws.Close()

	for {

		select {
		case <-c.pauseRead:
			<-c.resumeRead
		default:
		}

		msgType, data, err := c.ws.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err,
				websocket.CloseNormalClosure,
				websocket.CloseGoingAway,
			) && !isUnexpectedClose(err) {
				log.Printf("read error (%s): %v", c.id, err)
			}
			return
		}

		if msgType != websocket.BinaryMessage {
			log.Printf("non-binary message from %s; closing", c.id)

			_ = c.ws.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseUnsupportedData, "binary only"),
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
			log.Printf("relay error from %s to peer: %v", c.id, err)
			return
		}
	}
}

func (c *Connection) writeLoop() {
	ticker := time.NewTicker(pingPeriod)

	defer func() {
		ticker.Stop()
		c.ws.Close()
	}()

	for {
		select {

		case msg, ok := <-c.sendChan:

			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))

			if !ok {
				_ = c.ws.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			if err := c.ws.WriteMessage(websocket.BinaryMessage, msg); err != nil {

				if !websocket.IsCloseError(err,
					websocket.CloseNormalClosure,
					websocket.CloseGoingAway,
				) && !isUnexpectedClose(err) {
					log.Printf("write error (%s): %v", c.id, err)
				}

				return
			}

			// if buffer drained, resume peer reads
			if len(c.sendChan) < cap(c.sendChan) {
				select {
				case c.resumeRead <- struct{}{}:
				default:
				}
			}

		case <-ticker.C:

			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))

			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {

				if !websocket.IsCloseError(err,
					websocket.CloseNormalClosure,
					websocket.CloseGoingAway,
				) && !isUnexpectedClose(err) {
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
	return !websocket.IsUnexpectedCloseError(
		err,
		websocket.CloseNormalClosure,
		websocket.CloseGoingAway,
		websocket.CloseNoStatusReceived,
	)
}
