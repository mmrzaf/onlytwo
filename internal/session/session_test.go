package session

import (
	"errors"
	"testing"
	"time"
)

type fakeConn struct {
	id     string
	slot   string
	closed bool
	msgs   [][]byte
}

func (f *fakeConn) ID() string         { return f.id }
func (f *fakeConn) SlotToken() string  { return f.slot }
func (f *fakeConn) RemoteAddr() string { return "127.0.0.1" }
func (f *fakeConn) Send(msg []byte) error {
	cp := append([]byte(nil), msg...)
	f.msgs = append(f.msgs, cp)
	return nil
}
func (f *fakeConn) Close() error { f.closed = true; return nil }

func newTestSession(ttl time.Duration) *Session {
	return NewSession("ABCD-1234", "voice_first", "127.0.0.1", ttl)
}

func TestSessionStoresImmutableRoomProfile(t *testing.T) {
	s := newTestSession(time.Minute)
	if s.ProfileID != "voice_first" {
		t.Fatalf("unexpected profile %q", s.ProfileID)
	}
}

func TestSessionAddConnectionRejectsThirdSlot(t *testing.T) {
	s := newTestSession(time.Minute)
	if _, err := s.AddConnection(&fakeConn{id: "1", slot: "slot-1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddConnection(&fakeConn{id: "2", slot: "slot-2"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddConnection(&fakeConn{id: "3", slot: "slot-3"}); !errors.Is(err, ErrSessionFull) {
		t.Fatalf("expected full, got %v", err)
	}
}

func TestSessionReplacesSameSlot(t *testing.T) {
	s := newTestSession(time.Minute)
	first := &fakeConn{id: "1", slot: "slot-1"}
	second := &fakeConn{id: "2", slot: "slot-2"}
	replacement := &fakeConn{id: "3", slot: "slot-1"}
	_, _ = s.AddConnection(first)
	_, _ = s.AddConnection(second)
	result, err := s.AddConnection(replacement)
	if err != nil {
		t.Fatal(err)
	}
	if result.Replaced != first {
		t.Fatal("expected stale socket replacement")
	}
	if result.Peer != second {
		t.Fatal("expected the other participant")
	}
	if peer := s.PeerOf(second.ID()); peer != replacement {
		t.Fatal("expected replacement to be current")
	}
}

func TestSessionStaleRemoveDoesNotDeleteReplacement(t *testing.T) {
	s := newTestSession(time.Minute)
	first := &fakeConn{id: "1", slot: "slot-1"}
	replacement := &fakeConn{id: "2", slot: "slot-1"}
	_, _ = s.AddConnection(first)
	_, _ = s.AddConnection(replacement)
	if _, removed := s.RemoveConnection(first.SlotToken(), first.ID()); removed {
		t.Fatal("stale connection removed the replacement")
	}
	if len(s.Connections()) != 1 || s.Connections()[0] != replacement {
		t.Fatal("replacement should remain attached")
	}
}

func TestSessionPeerOf(t *testing.T) {
	s := newTestSession(time.Minute)
	_, _ = s.AddConnection(&fakeConn{id: "1", slot: "slot-1"})
	_, _ = s.AddConnection(&fakeConn{id: "2", slot: "slot-2"})
	peer := s.PeerOf("1")
	if peer == nil || peer.ID() != "2" {
		t.Fatal("unexpected peer")
	}
}

func TestSessionConnectedRoomDoesNotExpire(t *testing.T) {
	s := newTestSession(2 * time.Millisecond)
	conn := &fakeConn{id: "1", slot: "slot-1"}
	_, _ = s.AddConnection(conn)
	time.Sleep(4 * time.Millisecond)
	if s.IsExpired() {
		t.Fatal("connected room must not expire")
	}
	_, _ = s.RemoveConnection(conn.slot, conn.id)
	time.Sleep(4 * time.Millisecond)
	if !s.IsExpired() {
		t.Fatal("idle room should expire after the last peer leaves")
	}
}

func TestSessionCloseClosesConnections(t *testing.T) {
	s := newTestSession(time.Minute)
	conn := &fakeConn{id: "1", slot: "slot-1"}
	_, _ = s.AddConnection(conn)
	s.Close()
	if !conn.closed {
		t.Fatal("expected close")
	}
}
