package session

import (
	"errors"
	"testing"
	"time"
)

type fakeConn struct {
	id     string
	closed bool
	msgs   [][]byte
}

func (f *fakeConn) ID() string         { return f.id }
func (f *fakeConn) RemoteAddr() string { return "127.0.0.1" }
func (f *fakeConn) Send(msg []byte) error {
	cp := append([]byte(nil), msg...)
	f.msgs = append(f.msgs, cp)
	return nil
}
func (f *fakeConn) Close() error { f.closed = true; return nil }

func TestSession_AddConnection(t *testing.T) {
	s := NewSession("abcdefghijklmnop", time.Minute)
	if err := s.AddConnection(&fakeConn{id: "1"}); err != nil {
		t.Fatal(err)
	}
	if err := s.AddConnection(&fakeConn{id: "2"}); err != nil {
		t.Fatal(err)
	}
	if err := s.AddConnection(&fakeConn{id: "3"}); !errors.Is(err, ErrSessionFull) {
		t.Fatalf("expected full, got %v", err)
	}
}

func TestSession_PeerOf(t *testing.T) {
	s := NewSession("abcdefghijklmnop", time.Minute)
	_ = s.AddConnection(&fakeConn{id: "1"})
	_ = s.AddConnection(&fakeConn{id: "2"})
	peer := s.PeerOf("1")
	if peer == nil || peer.ID() != "2" {
		t.Fatalf("unexpected peer")
	}
}

func TestSession_CloseClosesConnections(t *testing.T) {
	s := NewSession("abcdefghijklmnop", time.Minute)
	c := &fakeConn{id: "1"}
	_ = s.AddConnection(c)
	s.Close()
	if !c.closed {
		t.Fatal("expected close")
	}
}
