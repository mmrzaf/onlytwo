package session

import (
	"errors"
	"testing"
)

type fakeConn struct {
	id     string
	closed bool
	msgs   [][]byte
}

func (f *fakeConn) ID() string {
	return f.id
}

func (f *fakeConn) Send(msg []byte) error {
	cp := make([]byte, len(msg))
	copy(cp, msg)
	f.msgs = append(f.msgs, cp)
	return nil
}

func (f *fakeConn) Close() error {
	f.closed = true
	return nil
}

func TestSession_AddConnection(t *testing.T) {
	s := NewSession("abc", 60)

	c1 := &fakeConn{id: "1"}
	c2 := &fakeConn{id: "2"}
	c3 := &fakeConn{id: "3"}

	if err := s.AddConnection(c1); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if err := s.AddConnection(c2); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	err := s.AddConnection(c3)
	if !errors.Is(err, ErrSessionFull) {
		t.Fatalf("expected ErrSessionFull, got %v", err)
	}
}

func TestSession_PeerOf(t *testing.T) {
	s := NewSession("abc", 60)

	c1 := &fakeConn{id: "1"}
	c2 := &fakeConn{id: "2"}

	_ = s.AddConnection(c1)
	_ = s.AddConnection(c2)

	peer := s.PeerOf("1")
	if peer == nil {
		t.Fatal("expected peer")
	}

	if peer.ID() != "2" {
		t.Fatalf("expected peer 2, got %s", peer.ID())
	}
}

func TestSession_RemoveConnection(t *testing.T) {
	s := NewSession("abc", 60)

	c1 := &fakeConn{id: "1"}

	_ = s.AddConnection(c1)

	if !s.HasConnections() {
		t.Fatal("expected connections")
	}

	s.RemoveConnection("1")

	if s.HasConnections() {
		t.Fatal("expected no connections")
	}
}

func TestSession_IsExpired(t *testing.T) {
	s := NewSession("abc", -1)

	if !s.IsExpired() {
		t.Fatal("expected session to be expired")
	}
}
