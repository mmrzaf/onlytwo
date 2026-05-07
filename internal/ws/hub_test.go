package ws

import (
	"testing"

	"github.com/mmrzaf/onlytwo/internal/config"
)

func TestHub_AttachDetachConnection(t *testing.T) {
	hub := NewHub(config.Config{
		SessionTTL: 60,
	})

	c1 := &Connection{id: "1"}
	c2 := &Connection{id: "2"}

	if err := hub.AttachConnection("abc", c1); err != nil {
		t.Fatalf("attach failed: %v", err)
	}

	if err := hub.AttachConnection("abc", c2); err != nil {
		t.Fatalf("attach failed: %v", err)
	}

	if c1.session == nil {
		t.Fatal("expected session assigned")
	}

	if c1.session != c2.session {
		t.Fatal("expected shared session")
	}

	hub.DetachConnection(c1)

	if c1.session.HasConnections() == false {
		t.Fatal("expected c2 still connected")
	}
}

func TestHub_RejectsThirdConnection(t *testing.T) {
	hub := NewHub(config.Config{
		SessionTTL: 60,
	})

	c1 := &Connection{id: "1"}
	c2 := &Connection{id: "2"}
	c3 := &Connection{id: "3"}

	_ = hub.AttachConnection("abc", c1)
	_ = hub.AttachConnection("abc", c2)

	if err := hub.AttachConnection("abc", c3); err == nil {
		t.Fatal("expected third connection rejection")
	}
}
