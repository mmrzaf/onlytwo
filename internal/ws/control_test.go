package ws

import "testing"

func TestRelayControlFrame(t *testing.T) {
	frame := relayControlFrame(relaySessionEnd)
	kind, ok := parseRelayControl(frame)
	if !ok || kind != relaySessionEnd {
		t.Fatalf("unexpected control parse: %v %v", kind, ok)
	}
	if _, ok := parseRelayControl([]byte{'O', 'T', 1, 4}); ok {
		t.Fatal("encrypted frame must not parse as relay control")
	}
}

func TestParseSlotProtocol(t *testing.T) {
	protocol, token, ok := parseSlotProtocol("other, onlytwo-slot.0123456789abcdef0123456789abcdef")
	if !ok {
		t.Fatal("expected valid slot protocol")
	}
	if protocol != "onlytwo-slot."+token {
		t.Fatal("unexpected protocol")
	}
	if _, _, ok := parseSlotProtocol("onlytwo-slot.invalid"); ok {
		t.Fatal("expected invalid token")
	}
}
