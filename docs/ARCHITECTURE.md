# Architecture

OnlyTwo v2 is split into strict layers.

| Layer | Responsibility |
|---|---|
| UI | Render state and collect user intent. No crypto or transport internals. |
| Session | Lifecycle, peer state, security state, feature coordination. |
| Transport | WebSocket connection, envelopes, lanes, bounded scheduling, metrics. |
| Crypto | Key exchange, message-key ratchet, encryption, decryption, safety code. |
| Features | Text, file streams, voice streams. |
| Server | Hardened blind relay, admission control, limits, headers. |

## Design rule

A failure in one feature must not corrupt or starve another feature.

Files are reliable bulk streams. Voice is a volatile realtime stream. Text is reliable and small. Control traffic is highest priority.

## Configuration rule

- Code defines canonical profiles.
- Server/env defines hard ceilings.
- UI exposes safe user intent.
- Per-chat profile is negotiated/visible.

## Security state

Sessions move through:

1. `disconnected`
2. `connecting`
3. `encrypted_unverified`
4. `verified`
5. `ended`

The UI must not show a session as fully secure until verified.
