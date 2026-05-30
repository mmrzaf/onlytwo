package ws

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/mmrzaf/onlytwo/internal/session"
)

var (
	_                session.ConnEndpoint = (*Connection)(nil)
	slotTokenPattern                      = regexp.MustCompile(`^[a-f0-9]{32}$`)
)

const slotProtocolPrefix = "onlytwo-slot."

type Connection struct {
	id        string
	slotToken string
	ip        string
	ws        *rawWSConn
	hub       *Hub
	session   *session.Session

	ctx       context.Context
	cancel    context.CancelFunc
	writeMu   sync.Mutex
	stateMu   sync.Mutex
	closed    bool
	sendChan  chan []byte
	closeOnce sync.Once
}

func newConnection(ws *rawWSConn, hub *Hub, ip, slotToken string) (*Connection, error) {
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Connection{id: id, slotToken: slotToken, ip: ip, ws: ws, hub: hub, ctx: ctx, cancel: cancel, sendChan: make(chan []byte, hub.cfg.SendBufferSize)}, nil
}

func (c *Connection) ID() string         { return c.id }
func (c *Connection) SlotToken() string  { return c.slotToken }
func (c *Connection) RemoteAddr() string { return c.ip }

func (c *Connection) Send(msg []byte) error {
	cp := append([]byte(nil), msg...)
	if c.isClosed() {
		return errors.New("connection closed")
	}
	select {
	case c.sendChan <- cp:
		return nil
	case <-c.ctx.Done():
		return errors.New("connection closed")
	default:
		return errors.New("connection send buffer full")
	}
}

func (c *Connection) SendPriority(msg []byte) error {
	if c.isClosed() {
		return errors.New("connection closed")
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.ws.SetWriteDeadline(time.Now().Add(c.hub.cfg.WriteWait))
	return c.ws.WriteMessage(wsBinaryMessage, msg)
}

func (c *Connection) CloseWithControl(msg []byte) error {
	c.writeMu.Lock()
	_ = c.ws.SetWriteDeadline(time.Now().Add(c.hub.cfg.WriteWait))
	_ = c.ws.WriteMessage(wsBinaryMessage, msg)
	_ = c.ws.WriteMessage(wsCloseMessage, formatCloseMessage(4000, "session ended"))
	c.writeMu.Unlock()
	return c.Close()
}

func (c *Connection) Close() error {
	c.closeOnce.Do(func() {
		c.stateMu.Lock()
		c.closed = true
		c.stateMu.Unlock()
		c.cancel()
		_ = c.ws.Close()
	})
	return nil
}

func (c *Connection) isClosed() bool {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return c.closed
}

type Handler struct{ hub *Hub }

func NewHandler(hub *Hub) http.Handler { return &Handler{hub: hub} }

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ip := h.hub.ClientIP(r)
	if !h.hub.limiter.Allow(ip) {
		http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
		return
	}
	if !h.hub.allowOrigin(r) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	code := r.URL.Query().Get("code")
	if !session.ValidCode(code) {
		http.Error(w, "invalid session code", http.StatusBadRequest)
		return
	}
	selectedProtocol, slotToken, ok := parseSlotProtocol(r.Header.Get("Sec-WebSocket-Protocol"))
	if !ok {
		http.Error(w, "invalid participant slot", http.StatusBadRequest)
		return
	}
	if !h.hub.reserveIP(ip) {
		http.Error(w, "too many connections", http.StatusTooManyRequests)
		return
	}

	wsConn, err := upgradeRaw(w, r, selectedProtocol)
	if err != nil {
		h.hub.releaseIP(ip)
		log.Printf("[ws] upgrade error ip=%s err=%v", ip, err)
		return
	}
	wsConn.SetReadLimit(h.hub.cfg.MaxMessageSize)
	_ = wsConn.SetReadDeadline(time.Now().Add(h.hub.cfg.PongWait))
	wsConn.SetPongHandler(func(string) error { return wsConn.SetReadDeadline(time.Now().Add(h.hub.cfg.PongWait)) })

	conn, err := newConnection(wsConn, h.hub, ip, slotToken)
	if err != nil {
		log.Printf("[ws] connection id error ip=%s err=%v", ip, err)
		_ = wsConn.Close()
		h.hub.releaseIP(ip)
		return
	}
	if err := h.hub.AttachConnection(code, conn); err != nil {
		log.Printf("[ws] attach failed ip=%s err=%v", ip, err)
		_ = wsConn.WriteMessage(wsCloseMessage, formatCloseMessage(1008, "session unavailable"))
		_ = wsConn.Close()
		h.hub.releaseIP(ip)
		return
	}

	go conn.writeLoop()
	conn.readLoop()
	h.hub.DetachConnection(conn)
}

func (c *Connection) readLoop() {
	defer c.Close()
	for {
		msgType, data, err := c.ws.ReadMessage()
		if err != nil {
			if !isRawNormalClose(err) {
				log.Printf("[ws] read error id=%s err=%v", c.id, err)
			}
			return
		}
		if msgType != wsBinaryMessage {
			_ = c.ws.WriteMessage(wsCloseMessage, formatCloseMessage(1003, "binary only"))
			return
		}
		if kind, isControl := parseRelayControl(data); isControl {
			if kind == relaySessionEnd {
				c.hub.EndSession(c)
				return
			}
			_ = c.ws.WriteMessage(wsCloseMessage, formatCloseMessage(1008, "invalid relay command"))
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
			log.Printf("[ws] relay dropped id=%s err=%v", c.id, err)
		}
	}
}

func (c *Connection) writeLoop() {
	ticker := time.NewTicker((c.hub.cfg.PongWait * 9) / 10)
	defer ticker.Stop()
	for {
		select {
		case msg := <-c.sendChan:
			c.writeMu.Lock()
			_ = c.ws.SetWriteDeadline(time.Now().Add(c.hub.cfg.WriteWait))
			err := c.ws.WriteMessage(wsBinaryMessage, msg)
			c.writeMu.Unlock()
			if err != nil {
				if !isRawNormalClose(err) {
					log.Printf("[ws] write error id=%s err=%v", c.id, err)
				}
				_ = c.Close()
				return
			}
		case <-ticker.C:
			c.writeMu.Lock()
			_ = c.ws.SetWriteDeadline(time.Now().Add(c.hub.cfg.WriteWait))
			err := c.ws.WriteMessage(wsPingMessage, nil)
			c.writeMu.Unlock()
			if err != nil {
				_ = c.Close()
				return
			}
		case <-c.ctx.Done():
			return
		}
	}
}

func parseSlotProtocol(header string) (string, string, bool) {
	for _, candidate := range strings.Split(header, ",") {
		protocol := strings.TrimSpace(candidate)
		if !strings.HasPrefix(protocol, slotProtocolPrefix) {
			continue
		}
		token := strings.TrimPrefix(protocol, slotProtocolPrefix)
		if slotTokenPattern.MatchString(token) {
			return protocol, token, true
		}
	}
	return "", "", false
}

func randomID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
