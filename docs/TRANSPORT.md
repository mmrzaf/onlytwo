# Transport v2

OnlyTwo uses a profile-driven, lane-based binary transport over WebSocket. The relay forwards opaque encrypted application frames and observes only connection metadata, frame timing, and frame sizes.

## Room profile

A room has one immutable named profile selected by the creator. The relay stores the profile ID. Joiners and refreshed peers resolve that same profile before starting the encrypted handshake. Both peers validate the canonical profile hash before encrypted application traffic begins.

## Encrypted envelope

Binary application frames use this 38-byte header:

```text
Magic(2) | ProtocolVersion(1) | OuterType(1) | Flags(1) | HeaderLen(1) |
StreamID(4) | Sequence(4) | Counter(8) | Nonce(12) | PayloadLen(4) |
Payload(var)
```

All integer fields are big-endian. Header metadata through the nonce is authenticated as AEAD associated data for encrypted data frames. `OuterType=HANDSHAKE` carries the versioned key-exchange handshake. `OuterType=DATA` carries encrypted application messages.

## Streams and lanes

| Stream | Lane | Semantics | Backpressure |
|---:|---|---|---|
| 0 | control | unencrypted handshake only | bounded failure |
| 1 | control | encrypted lifecycle, reliable control, ACK, cancel | never drop; bounded failure |
| 2 | text | encrypted reliable chat messages | never drop; bounded failure |
| 3 | file | encrypted file chunks | bounded window; pause and retry |
| 4 | voice | encrypted realtime PCM frames | latest wins; stale audio drops |

Inbound encrypted messages are checked against their authenticated stream before dispatch. Voice work is bounded before encryption, before decryption, and before playback to prevent latency growth during continuous speech.

## Refresh and rejoin

A refreshed browser reuses its participant slot token and starts a fresh cryptographic epoch. The surviving peer keeps its local transcript, but stale queued encrypted packets, voice state, and active file transfers are discarded. The safety phrase changes and must be verified again.

## Explicit termination

`End chat for both` is a relay-control command. The relay tombstones the room code for the configured session TTL, closes both peers, and prevents reuse of the old code during that interval.
