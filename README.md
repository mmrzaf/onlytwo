# OnlyTwo — Secure 1:1 Ephemeral Messenger

**No accounts. No storage. No trace.**

OnlyTwo is a browser‑based, end‑to‑end encrypted chat for exactly two people.  
It uses the Web Crypto API to encrypt every message before it leaves your device, and a lightweight relay server that never stores anything.

---

## Features

- **End‑to‑end encrypted** – Double Ratchet with AES‑256‑GCM.
- **Perfect forward secrecy** – compromising a key does not reveal past messages.
- **Fixed‑size packets** – all ciphertexts are 64 KiB to resist traffic analysis.
- **Ephemeral** – close the tab and the conversation is gone.
- **No sign‑up** – share a random session code to connect.
- **Verifiable security** – an 8‑digit fingerprint you can compare with your peer.

---

## Quick Start

### 1. Build & Run the Server

```bash
make dev
```

The server listens on `http://localhost:8080`. Open it in two browser tabs, create a session, and share the code.

### 2. Production Deployment

Place the binary behind a reverse proxy (Caddy/Nginx) with TLS.  
The server already sets all necessary security headers (`COOP`, `COEP`, etc.).

---

## Project Structure

```
onlytwo/
├── client/                 # TypeScript + Vite frontend
│   ├── src/
│   │   ├── crypto/         # Web Crypto worker & client
│   │   ├── session/        # Session controller & handshake
│   │   ├── transport/      # WebSocket client & protocol
│   │   ├── ui/             # DOM, messages, status bar
│   │   └── state/          # Client state management
│   └── ...
├── cmd/onlytwo-server/     # Go server entry point
├── internal/
│   ├── config/             # Server configuration
│   ├── http/               # HTTP routes & security headers
│   ├── session/            # In‑memory session registry
│   └── ws/                 # WebSocket handling & relay
├── static.go               # Embedded static file server
├── SDD.md                  # System Design Document
└── Makefile                # Build helpers
```

---

## Technology

| Layer     | Stack                        |
|-----------|------------------------------|
| Frontend  | TypeScript, Vite, Web Crypto |
| Backend   | Go, Gorilla WebSocket        |
| Crypto    | X25519, HKDF, AES‑256‑GCM    |

All crypto runs in a dedicated Web Worker; the main thread never sees raw keys.

---

## Documentation

- **[SDD.md](SDD.md)** – full system design, protocol, threat model, and deployment guide.

---

## Security

OnlyTwo is designed for privacy‑sensitive conversations.  
The server is a dumb pipe: it sees only encrypted blobs of identical size.  
For a detailed threat model, see [SDD.md §8](SDD.md#8-threat-model).

**If you discover a vulnerability**, please open an issue or contact the maintainers privately.

---

## License

MIT – see [LICENSE](LICENSE).


---

## Contributing

Contributions are welcome. Please ensure that any change to the cryptographic protocol is reviewed and documented in SDD.md.

---

**Built with privacy as a default, not a feature.**
