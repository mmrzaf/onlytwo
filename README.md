# OnlyTwo

OnlyTwo is a two-party, browser-based encrypted messenger for text, file transfer, and voice chat over a hardened WebSocket relay.

The relay is intentionally dumb: it creates short-lived rooms, admits two peers, enforces transport limits, and forwards opaque binary frames. Message content is encrypted in the browser before it reaches the server.

## Core properties

* two-party rooms;
* browser-side encryption before relay transit;
* opaque WebSocket frame forwarding;
* profile-driven transport limits;
* bounded lane-based packet queues;
* encrypted text, file, and voice messages;
* explicit encrypted-unverified and verified session states;
* out-of-band safety-code verification;
* server-side origin checks, rate limits, frame limits, and security headers.

## Security model

OnlyTwo encrypts application content in the browser. The relay does not decrypt message payloads.

A session is encrypted after key exchange, but it is not authenticated until both users compare the displayed safety code through an independent channel. Until that comparison is complete, the session must be treated as **encrypted but unverified**.

A verified session means both users confirmed they are seeing the same cryptographic session. It does not mean the software has been externally audited, the browser environment is uncompromised, or the hosting operator is trusted with endpoint security.

OnlyTwo uses browser WebCrypto primitives and a custom message-key ratchet. This design is suitable as a strong application-security baseline, but high-risk deployments should require independent cryptographic and implementation review.

## Features

### Text

Text messages are encrypted client-side and sent through the relay as opaque frames.

### File transfer

Files are split into bounded chunks, encrypted in the browser, transferred over the file lane, and reconstructed by the receiving peer.

### Voice

Voice chat uses encrypted PCM16 voice frames. Voice behavior is controlled by the selected transport profile and may prioritize bandwidth, latency, or traffic-shaping characteristics.

## Transport profiles

Transport profiles are defined in `client/src/config/profiles.ts`.

Available profiles:

* `balanced` — default profile for normal use.
* `low_data` — reduces bandwidth pressure with tighter transport behavior.
* `voice_first` — prioritizes voice responsiveness over bulk transfer.
* `maximum_privacy` — favors larger padding buckets and stronger traffic-shaping behavior.

Profiles express user intent. Server-side limits remain authoritative.

## Architecture

OnlyTwo is split into four main layers:

1. **Browser client** — UI, session state, crypto worker, message protocol, file transfer, voice capture/playback, and WebSocket transport.
2. **Protocol layer** — binary envelopes, encrypted application messages, profile negotiation, reliable control/text delivery, and lane scheduling.
3. **Relay server** — HTTP routing, static asset serving, WebSocket upgrade handling, session registry, admission checks, rate limits, and frame forwarding.
4. **Deployment layer** — embedded Vite build, Go server binary, Docker image, and release automation.

More detail is available in:

* `docs/ARCHITECTURE.md`
* `docs/SECURITY.md`
* `docs/TRANSPORT.md`
* `SDD.md`

## Local development

Run the full local development stack:

```bash
make dev
```

Or run server and client separately:

```bash
make server
make client
```

The client is served by Vite during development. The Go server handles relay and HTTP endpoints.

## Build

Build the production client and server:

```bash
make build
```

The production Go binary embeds `client/dist`.

## Test

Run Go tests:

```bash
make test-go
```

Run client tests:

```bash
make test-client
```

Run the full test suite:

```bash
make test
```

## Configuration

Runtime configuration is provided through environment variables.

Common server settings:

```bash
ONLYTWO_ADDR=:8080
ONLYTWO_ALLOWED_ORIGINS=https://your-domain.example
ONLYTWO_SESSION_TTL_SECONDS=3600
ONLYTWO_MAX_FRAME_BYTES=262144
ONLYTWO_SEND_BUFFER_SIZE=128
ONLYTWO_RATE_LIMIT_PER_MINUTE=600
ONLYTWO_MAX_SESSIONS_PER_IP=64
ONLYTWO_MAX_CONNECTIONS_PER_IP=128
ONLYTWO_WRITE_WAIT_SECONDS=10
ONLYTWO_PONG_WAIT_SECONDS=60
```

`ONLYTWO_ALLOWED_ORIGINS` should be set explicitly in production. Use comma-separated origins when multiple public origins are valid.

## Deployment

OnlyTwo can be deployed as a single Go server that serves the embedded browser client and WebSocket relay.

A typical deployment should place the server behind TLS and a trusted reverse proxy. The public origin configured in the reverse proxy must match `ONLYTWO_ALLOWED_ORIGINS`.

## Operational notes

* Use HTTPS/WSS in production.
* Keep origin allowlists explicit.
* Keep server frame limits aligned with client transport profiles.
* Treat unverified sessions as encrypted transport only, not authenticated communication.
* Do not rely on the relay for confidentiality; confidentiality is provided by the browser clients.
* Do not use this system for high-risk communication without independent security review.

## License

OnlyTwo is licensed under the **GNU GPL 3.0 or later**.
See the [`LICENSE`](./LICENSE) file for details.

