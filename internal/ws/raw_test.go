package ws

import (
	"bufio"
	"bytes"
	"strings"
	"testing"
)

func TestHeaderHasTokenRequiresExactConnectionToken(t *testing.T) {
	if !headerHasToken([]string{"keep-alive, Upgrade"}, "upgrade") {
		t.Fatal("expected exact upgrade token")
	}
	if headerHasToken([]string{"keep-alive, notupgrade"}, "upgrade") {
		t.Fatal("substring must not count as an upgrade token")
	}
}

func TestReadFrameRejectsUnmaskedClientFrame(t *testing.T) {
	conn := &rawWSConn{reader: bufio.NewReader(bytes.NewReader([]byte{0x82, 0x01, 0x00})), limit: 1024}
	if _, _, err := conn.readFrame(); err == nil || !strings.Contains(err.Error(), "masked") {
		t.Fatalf("expected masked-frame rejection, got %v", err)
	}
}

func TestReadFrameRejectsOversizedControlFrame(t *testing.T) {
	payload := bytes.Repeat([]byte{0x00}, 126)
	frame := maskedFrame(wsPingMessage, payload)
	conn := &rawWSConn{reader: bufio.NewReader(bytes.NewReader(frame)), limit: 1024}
	if _, _, err := conn.readFrame(); err == nil || !strings.Contains(err.Error(), "control frame too large") {
		t.Fatalf("expected control-frame rejection, got %v", err)
	}
}

func TestReadFrameRejectsOneByteClosePayload(t *testing.T) {
	frame := maskedFrame(wsCloseMessage, []byte{0x00})
	conn := &rawWSConn{reader: bufio.NewReader(bytes.NewReader(frame)), limit: 1024}
	if _, _, err := conn.readFrame(); err == nil || !strings.Contains(err.Error(), "close payload") {
		t.Fatalf("expected close-payload rejection, got %v", err)
	}
}

func maskedFrame(opcode int, payload []byte) []byte {
	mask := []byte{1, 2, 3, 4}
	frame := []byte{0x80 | byte(opcode), 0x80}
	if len(payload) < 126 {
		frame[1] |= byte(len(payload))
	} else {
		frame[1] |= 126
		frame = append(frame, byte(len(payload)>>8), byte(len(payload)))
	}
	frame = append(frame, mask...)
	for i, value := range payload {
		frame = append(frame, value^mask[i%len(mask)])
	}
	return frame
}
