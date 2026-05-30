package ws

const (
	relayControlMagicA  = byte('O')
	relayControlMagicB  = byte('R')
	relayControlVersion = byte(1)

	relayPeerPresent      = byte(1)
	relayPeerDisconnected = byte(2)
	relayPeerRejoined     = byte(3)
	relaySessionEnd       = byte(4)
	relaySessionEnded     = byte(5)
)

func relayControlFrame(kind byte) []byte {
	return []byte{relayControlMagicA, relayControlMagicB, relayControlVersion, kind}
}

func parseRelayControl(data []byte) (byte, bool) {
	if len(data) != 4 || data[0] != relayControlMagicA || data[1] != relayControlMagicB || data[2] != relayControlVersion {
		return 0, false
	}
	if data[3] < relayPeerPresent || data[3] > relaySessionEnded {
		return 0, false
	}
	return data[3], true
}
