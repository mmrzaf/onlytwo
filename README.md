# OnlyTwo v2

OnlyTwo is a two-party, browser-based encrypted messenger with text, file transfer, and experimental voice chat over a hardened WebSocket relay.

This rewrite focuses on:

- profile-driven transport configuration;
- bounded lane-based queues;
- safer browser UI rendering;
- hardened relay admission and security headers;
- encrypted text/file/voice frames;
- explicit `encrypted_unverified` vs `verified` session states;
- clearer architecture and test boundaries.

## Security posture

OnlyTwo encrypts content in the browser before it reaches the relay. The relay forwards opaque binary frames and does not decrypt payloads.

A session is **encrypted but unverified** after key exchange. It becomes **verified** only after both users compare the displayed safety code out-of-band. Do not describe an unverified session as fully secure.

This project uses browser WebCrypto primitives and a custom message-key ratchet. It is not a substitute for an externally audited cryptographic protocol implementation. Treat this as a strong architecture baseline that still requires professional security review before high-risk deployment.

## Transport profiles

Profiles are defined in `client/src/config/profiles.ts` and constrained by server-side limits.

- `balanced`: default for normal use.
- `low_bandwidth`: smaller queues and longer voice frames.
- `best_voice`: voice-first scheduling.
- `maximum_privacy`: larger fixed padding and constant voice cadence option.

Users choose intent-level profiles. The server owns hard limits.

## Run locally

```bash
make dev
```

In separate terminals:

```bash
make server
make client
```

## Build

```bash
make build
```

The Go binary embeds `client/dist`.

## Environment

See `.env.example`.

Important production settings:

- `ONLYTWO_ALLOWED_ORIGINS=https://your-domain.example`
- `ONLYTWO_MAX_FRAME_BYTES=262144`
- `ONLYTWO_SESSION_TTL_SECONDS=3600`
- `ONLYTWO_RATE_LIMIT_PER_MINUTE=600`

## Architecture docs

See `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, and `docs/TRANSPORT.md`.
