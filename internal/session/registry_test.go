package session

import (
	"testing"
	"time"
)

func TestRegistry_GetOrCreateSession_ReusesLiveSession(t *testing.T) {
	r := NewRegistry(60)

	s1 := r.GetOrCreateSession("room")
	s2 := r.GetOrCreateSession("room")

	if s1 != s2 {
		t.Fatal("expected same session instance")
	}
}

func TestRegistry_GetOrCreateSession_ReplacesExpired(t *testing.T) {
	r := NewRegistry(60)

	s1 := r.GetOrCreateSession("room")
	s1.ExpiresAt = time.Now().Add(-time.Second)

	s2 := r.GetOrCreateSession("room")

	if s1 == s2 {
		t.Fatal("expected expired session replacement")
	}
}

func TestRegistry_GetSession(t *testing.T) {
	r := NewRegistry(60)

	expected := r.GetOrCreateSession("room")

	got, ok := r.GetSession("room")
	if !ok {
		t.Fatal("expected session")
	}

	if got != expected {
		t.Fatal("unexpected session returned")
	}
}

func TestRegistry_GetSession_Expired(t *testing.T) {
	r := NewRegistry(60)

	s := r.GetOrCreateSession("room")
	s.ExpiresAt = time.Now().Add(-time.Second)

	_, ok := r.GetSession("room")
	if ok {
		t.Fatal("expected expired session to be hidden")
	}
}

func TestRegistry_RemoveSession(t *testing.T) {
	r := NewRegistry(60)

	r.GetOrCreateSession("room")
	r.RemoveSession("room")

	_, ok := r.GetSession("room")
	if ok {
		t.Fatal("expected removed session")
	}
}

func TestRegistry_SweepExpired(t *testing.T) {
	r := NewRegistry(60)

	s := r.GetOrCreateSession("room")
	s.ExpiresAt = time.Now().Add(-time.Second)

	r.sweepExpired()

	_, ok := r.GetSession("room")
	if ok {
		t.Fatal("expected expired session removed")
	}
}
