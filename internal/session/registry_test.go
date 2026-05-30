package session

import (
	"errors"
	"testing"
	"time"
)

func TestValidCode(t *testing.T) {
	if !ValidCode("ABCD-1234") {
		t.Fatal("expected valid")
	}
	if ValidCode("short") || ValidCode("bad code bad code") || ValidCode("abcdefghijklmnop") {
		t.Fatal("expected invalid")
	}
}

func TestValidProfileID(t *testing.T) {
	if !ValidProfileID("voice_first") || ValidProfileID("unknown") {
		t.Fatal("unexpected profile validation")
	}
}

func TestRegistryExplicitCreateAndLookup(t *testing.T) {
	r := NewRegistry(time.Minute)
	if _, ok := r.GetSession("ABCD-1234"); ok {
		t.Fatal("lookup must not create a room")
	}
	s, err := r.CreateSessionWithCode("ABCD-1234", "voice_first", "127.0.0.1", 10)
	if err != nil {
		t.Fatal(err)
	}
	found, ok := r.GetSession("ABCD-1234")
	if !ok || found != s || found.ProfileID != "voice_first" {
		t.Fatal("expected created room with locked profile")
	}
	if _, err := r.CreateSessionWithCode("ABCD-1234", "balanced", "127.0.0.1", 10); !errors.Is(err, ErrSessionExists) {
		t.Fatalf("expected collision, got %v", err)
	}
}

func TestRegistryExpiredIdleRoomCanBeRecreated(t *testing.T) {
	r := NewRegistry(time.Millisecond)
	s1, err := r.CreateSessionWithCode("ABCD-1234", "balanced", "127.0.0.1", 10)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(3 * time.Millisecond)
	if _, ok := r.GetSession("ABCD-1234"); ok {
		t.Fatal("expected expired room lookup to fail")
	}
	s2, err := r.CreateSessionWithCode("ABCD-1234", "voice_first", "127.0.0.1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if s1 == s2 || s2.ProfileID != "voice_first" {
		t.Fatal("expected a new room")
	}
}

func TestRegistryEndSessionTombstonesCode(t *testing.T) {
	r := NewRegistry(time.Minute)
	s, err := r.CreateSessionWithCode("ABCD-1234", "balanced", "127.0.0.1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if !r.EndSession("ABCD-1234", s) {
		t.Fatal("expected end")
	}
	if _, err := r.CreateSessionWithCode("ABCD-1234", "balanced", "127.0.0.1", 10); !errors.Is(err, ErrSessionExists) {
		t.Fatal("ended room code must not be immediately reusable")
	}
}

func TestRegistryEnforcesSessionCreationLimit(t *testing.T) {
	r := NewRegistry(time.Minute)
	if _, err := r.CreateSessionWithCode("ABCD-1234", "balanced", "127.0.0.1", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := r.CreateSessionWithCode("EFGH-5678", "balanced", "127.0.0.1", 1); !errors.Is(err, ErrTooManySessions) {
		t.Fatalf("expected IP room limit, got %v", err)
	}
	if _, err := r.CreateSessionWithCode("WXYZ-5678", "balanced", "127.0.0.2", 1); err != nil {
		t.Fatal("different IP should be allowed")
	}
}

func TestRegistryRejectsInvalidProfile(t *testing.T) {
	r := NewRegistry(time.Minute)
	if _, err := r.CreateSessionWithCode("ABCD-1234", "not-real", "127.0.0.1", 10); !errors.Is(err, ErrInvalidProfile) {
		t.Fatalf("expected invalid profile, got %v", err)
	}
}
