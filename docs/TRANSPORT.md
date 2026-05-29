# Transport v2

The transport is profile-driven and lane-based.

## Envelope

Binary frame layout:

```text
Magic(2) | Version(1) | Type(1) | Lane(1) | Flags(1) | HeaderLen(2) |
StreamID(8) | Seq(8) | Ack(8) | TimestampMs(8) | Nonce(12) |
PayloadLen(4) | Payload(var)
```

Header size is 56 bytes.

## Lanes

| Lane | Semantics | Backpressure |
|---|---|---|
| control | handshake, negotiation, ACK, cancel | never drop; bounded failure |
| text | chat messages | never drop; bounded failure |
| file | reliable bulk | pause/throttle |
| voice | realtime volatile | drop oldest |

## Profiles

Profiles define padding, chunk sizes, queue budgets, and voice behavior. Profiles are safe named policies, not arbitrary low-level sliders.
