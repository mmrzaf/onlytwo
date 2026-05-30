package ws

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	wsTextMessage   = 1
	wsBinaryMessage = 2
	wsCloseMessage  = 8
	wsPingMessage   = 9
	wsPongMessage   = 10
)

type rawWSConn struct {
	netConn net.Conn
	reader  *bufio.Reader
	limit   int64
	onPong  func(string) error
	writeMu sync.Mutex
}

func upgradeRaw(w http.ResponseWriter, r *http.Request, selectedProtocol string) (*rawWSConn, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || !headerHasToken(r.Header.Values("Connection"), "upgrade") {
		return nil, errors.New("not a websocket upgrade")
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	decodedKey, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(decodedKey) != 16 {
		return nil, errors.New("invalid websocket key")
	}
	if strings.TrimSpace(r.Header.Get("Sec-WebSocket-Version")) != "13" {
		return nil, errors.New("unsupported websocket version")
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("hijacking not supported")
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return nil, err
	}
	accept := websocketAccept(key)
	protocolHeader := ""
	if selectedProtocol != "" {
		protocolHeader = fmt.Sprintf("Sec-WebSocket-Protocol: %s\r\n", selectedProtocol)
	}
	_, err = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n%s\r\n", accept, protocolHeader)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &rawWSConn{netConn: conn, reader: rw.Reader, limit: 1024 * 1024}, nil
}

func headerHasToken(values []string, target string) bool {
	for _, value := range values {
		for _, token := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(token), target) {
				return true
			}
		}
	}
	return false
}

func websocketAccept(key string) string {
	h := sha1.New()
	_, _ = h.Write([]byte(key))
	_, _ = h.Write([]byte("258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func (c *rawWSConn) SetReadLimit(limit int64)             { c.limit = limit }
func (c *rawWSConn) SetReadDeadline(t time.Time) error    { return c.netConn.SetReadDeadline(t) }
func (c *rawWSConn) SetWriteDeadline(t time.Time) error   { return c.netConn.SetWriteDeadline(t) }
func (c *rawWSConn) SetPongHandler(fn func(string) error) { c.onPong = fn }
func (c *rawWSConn) Close() error                         { return c.netConn.Close() }

func (c *rawWSConn) ReadMessage() (int, []byte, error) {
	for {
		opcode, payload, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch opcode {
		case wsBinaryMessage, wsTextMessage:
			return opcode, payload, nil
		case wsCloseMessage:
			return wsCloseMessage, nil, io.EOF
		case wsPingMessage:
			if err := c.WriteMessage(wsPongMessage, payload); err != nil {
				return 0, nil, err
			}
		case wsPongMessage:
			if c.onPong != nil {
				if err := c.onPong(string(payload)); err != nil {
					return 0, nil, err
				}
			}
		default:
			return 0, nil, errors.New("unsupported websocket opcode")
		}
	}
}

func (c *rawWSConn) readFrame() (int, []byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(c.reader, hdr[:]); err != nil {
		return 0, nil, err
	}
	if hdr[0]&0x70 != 0 {
		return 0, nil, errors.New("websocket RSV bits are not supported")
	}
	fin := hdr[0]&0x80 != 0
	opcode := int(hdr[0] & 0x0f)
	masked := hdr[1]&0x80 != 0
	if !masked {
		return 0, nil, errors.New("client websocket frames must be masked")
	}
	if !validOpcode(opcode) {
		return 0, nil, errors.New("unsupported websocket opcode")
	}
	if !fin {
		return 0, nil, errors.New("fragmented websocket frames are not supported")
	}

	length := uint64(hdr[1] & 0x7f)
	if length == 126 {
		var ext [2]byte
		if _, err := io.ReadFull(c.reader, ext[:]); err != nil {
			return 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	} else if length == 127 {
		var ext [8]byte
		if _, err := io.ReadFull(c.reader, ext[:]); err != nil {
			return 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
		if length&(1<<63) != 0 {
			return 0, nil, errors.New("invalid websocket frame length")
		}
	}
	if opcode >= wsCloseMessage && length > 125 {
		return 0, nil, errors.New("websocket control frame too large")
	}
	if opcode == wsCloseMessage && length == 1 {
		return 0, nil, errors.New("invalid websocket close payload")
	}
	if c.limit > 0 && length > uint64(c.limit) {
		return 0, nil, errors.New("websocket frame too large")
	}
	if length > uint64(math.MaxInt) {
		return 0, nil, errors.New("websocket frame too large")
	}

	var mask [4]byte
	if _, err := io.ReadFull(c.reader, mask[:]); err != nil {
		return 0, nil, err
	}
	payload := make([]byte, int(length))
	if _, err := io.ReadFull(c.reader, payload); err != nil {
		return 0, nil, err
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	return opcode, payload, nil
}

func validOpcode(opcode int) bool {
	switch opcode {
	case wsTextMessage, wsBinaryMessage, wsCloseMessage, wsPingMessage, wsPongMessage:
		return true
	default:
		return false
	}
}

func (c *rawWSConn) WriteMessage(opcode int, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.writeMessageLocked(opcode, payload)
}

func (c *rawWSConn) writeMessageLocked(opcode int, payload []byte) error {
	var header [10]byte
	header[0] = 0x80 | byte(opcode&0x0f)
	var n int
	if len(payload) < 126 {
		header[1] = byte(len(payload))
		n = 2
	} else if len(payload) <= 0xffff {
		header[1] = 126
		binary.BigEndian.PutUint16(header[2:4], uint16(len(payload)))
		n = 4
	} else {
		header[1] = 127
		binary.BigEndian.PutUint64(header[2:10], uint64(len(payload)))
		n = 10
	}
	if _, err := c.netConn.Write(header[:n]); err != nil {
		return err
	}
	_, err := c.netConn.Write(payload)
	return err
}

func formatCloseMessage(code int, text string) []byte {
	payload := make([]byte, 2+len(text))
	binary.BigEndian.PutUint16(payload[:2], uint16(code))
	copy(payload[2:], text)
	return payload
}

func isRawNormalClose(err error) bool {
	return errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed)
}
