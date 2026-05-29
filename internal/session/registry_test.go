package session

import (
	"testing"
	"time"
)

func TestValidCode(t *testing.T) {
	if !ValidCode("abcdefghijklmnop") {
		t.Fatal("expected valid")
	}
	if ValidCode("short") {
		t.Fatal("expected invalid")
	}
	if ValidCode("bad code bad code") {
		t.Fatal("expected invalid")
	}
}

func TestRegistry_GetOrCreateSession(t *testing.T) {
	r := NewRegistry(time.Minute)
	s1, ok := r.GetOrCreateSession("abcdefghijklmnop")
	if !ok {
		t.Fatal("expected ok")
	}
	s2, ok := r.GetOrCreateSession("abcdefghijklmnop")
	if !ok || s1 != s2 {
		t.Fatal("expected same session")
	}
}

func TestRegistry_ReplacesExpired(t *testing.T) {
	r := NewRegistry(time.Millisecond)
	s1, _ := r.GetOrCreateSession("abcdefghijklmnop")
	time.Sleep(2 * time.Millisecond)
	s2, _ := r.GetOrCreateSession("abcdefghijklmnop")
	if s1 == s2 {
		t.Fatal("expected replacement")
	}
}
