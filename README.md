# OnlyTwo

OnlyTwo is a private, ephemeral browser room for exactly two people. Messages, files, and realtime voice are encrypted in the browser before they leave either device. The server creates rooms, relays opaque frames, and coordinates lifecycle events; it does not store chat history.

Current release candidate: `v2.0.0-beta.3`  
Wire protocol: `2`

## Product behavior

- The creator selects one locked transport profile when creating a room.
- A joiner enters only the room code and inherits that room profile.
- Refresh and temporary network loss preserve the room but start a fresh cryptographic epoch. A refreshed browser does not recover previous transcript messages or files.
- `End chat for both` deletes the active room, clears both local chat views, and tombstones the previous room code for the session TTL.
- Voice is realtime: stale audio is dropped instead of accumulating delay.
- File transfers are chunked, bounded, and paused during active voice when required by runtime policy.

## Requirements

- Go toolchain from `go.mod`
- Node.js 22
- HTTPS for deployed microphone access

## Local development

```bash
cd client
npm ci
cd ..
make dev
```

Run validation:

```bash
cd client
npm ci
npm test -- --run
npm run build
cd ..
go test ./...
go vet ./...
go test -race ./internal/session ./internal/http ./internal/ws
```

## Deployment

The included Docker image embeds the production Vite build in the Go server. Configure the deployment with environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `ONLYTWO_ADDR` | `:8080` | HTTP listen address inside the container |
| `ONLYTWO_ALLOWED_ORIGINS` | empty | Comma-separated browser origins allowed to open WebSockets, for example `https://chat.example.com` |
| `ONLYTWO_TRUSTED_PROXIES` | empty | Comma-separated reverse-proxy IPs or CIDRs permitted to supply forwarded client IP headers |
| `ONLYTWO_SESSION_TTL_SECONDS` | `3600` | Idle-room expiry and ended-room tombstone lifetime |
| `ONLYTWO_MAX_FRAME_BYTES` | `262144` | Maximum relayed WebSocket frame size |
| `ONLYTWO_MAX_SESSIONS_PER_IP` | `64` | Room creation admission limit per client IP |
| `ONLYTWO_MAX_CONNECTIONS_PER_IP` | `128` | Concurrent WebSocket admission limit per client IP |

Set `ONLYTWO_TRUSTED_PROXIES` narrowly. Do not trust a broad public range. When the Go server is directly exposed, leave it empty.

The provided Compose file expects `ONLYTWO_DOMAIN` and sets:

```text
ONLYTWO_ADDR=:8080
ONLYTWO_ALLOWED_ORIGINS=https://${ONLYTWO_DOMAIN}
```

## Security scope

OnlyTwo provides encrypted ephemeral transport between two browsers and a user-verifiable safety phrase. The relay still observes connection metadata, timing, and encrypted frame sizes. A browser cannot erase screenshots, saved downloads, or data copied by a peer.

See `docs/SECURITY.md`, `docs/ARCHITECTURE.md`, and `docs/TRANSPORT.md` for the detailed model.

## Release checklist

Before tagging a beta release, test Debian and Android browsers in both directions:

1. Create every room profile and confirm the joiner inherits the locked profile.
2. Refresh either peer and confirm the same room profile remains active with a new safety phrase.
3. Mistype a room code and confirm joining fails immediately.
4. Send files in both directions, including a large file.
5. Run continuous voice for at least ten minutes and confirm delay stays bounded.
6. Refresh during voice and during a file transfer.
7. Press `End chat for both` from either side and confirm the old room code is rejected.
