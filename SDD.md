# System Design Document — OnlyTwo

**Version:** 1.0.0  
**Date:** 2026-05-07  
**Status:** Final  
**Repository:** `github.com/mmrzaf/onlytwo`

---

## Table of Contents

1. [Introduction](#1-introduction)
   - 1.1 Purpose
   - 1.2 Scope
   - 1.3 Design Goals
2. [System Overview](#2-system-overview)
   - 2.1 High‑Level Architecture
   - 2.2 Component Interaction
3. [Client Architecture](#3-client-architecture)
   - 3.1 Technology Stack
   - 3.2 Threading Model
   - 3.3 State Machine
   - 3.4 User Interface
4. [Server Architecture](#4-server-architecture)
   - 4.1 Core Packages
   - 4.2 Session Registry
   - 4.3 WebSocket Handling
   - 4.4 Operational Behaviour
5. [Security Design](#5-security-design)
   - 5.1 Cryptographic Primitives
   - 5.2 Key Hierarchy & Initial Handshake
   - 5.3 Double Ratchet Protocol
   - 5.4 Message Padding & Traffic Analysis Resistance
   - 5.5 Replay Protection
   - 5.6 Out‑of‑Order Handling
   - 5.7 Fingerprint Verification
6. [Communication Protocol](#6-communication-protocol)
   - 6.1 WebSocket Envelope Layout
   - 6.2 Plaintext Structure (Pre‑Encryption)
   - 6.3 Message Types
   - 6.4 Handshake Process
7. [File Transfer](#7-file-transfer)
   - 7.1 Metadata & Chunking
   - 7.2 Strict Sequential Queue
   - 7.3 Receiver Assembly
8. [Threat Model](#8-threat-model)
9. [Deployment & Hardening](#9-deployment--hardening)
10. [Future Enhancements](#10-future-enhancements)
11. [Appendix](#11-appendix)

---

## 1. Introduction

### 1.1 Purpose

OnlyTwo is a browser‑based, ephemeral, end‑to‑end encrypted messenger for **exactly two participants**.  
It provides a secure, temporary communication channel without requiring accounts, installations, or server‑side data storage.

This document describes the complete system design — covering architecture, protocol, security properties, and operational guidelines — and serves as the authoritative technical reference.

### 1.2 Scope

The system consists of:
- A **TypeScript client** running in a web browser.
- A **Go relay server** that forwards encrypted binary packets between two connected clients.

All cryptographic operations happen **exclusively on the client** using the native Web Crypto API.  
The server has no access to plaintext, keys, or message contents.

### 1.3 Design Goals

| Goal | Implementation |
|------|----------------|
| **End‑to‑end encryption** | Double Ratchet with AES‑256‑GCM |
| **Perfect forward secrecy** | DH ratchet steps |
| **Post‑compromise security** | DH ratchet resets |
| **Traffic analysis resistance** | Fixed 64 KiB ciphertexts |
| **No user identifiers** | Random session codes, no accounts |
| **Zero server persistence** | In‑memory relay only |
| **Verifiable connection security** | Visual fingerprint derived from key material |

---

## 2. System Overview

### 2.1 High‑Level Architecture

```
┌──────────────┐         WebSocket (binary)         ┌──────────────┐
│  Browser A   │ ═══════════════════════════════════ │  Browser B   │
│ (TypeScript) │            relay server             │ (TypeScript) │
│              │           (Go, memory)              │              │
└──────────────┘                                    └──────────────┘
```

- **Clients** connect to the server via a session code.
- The **server** pairs exactly two clients per code, relaying opaque binary frames.
- **No messages are stored** on the server — it acts as a temporary pipe.

### 2.2 Component Interaction

1. User A creates or enters a session code.
2. Client A connects to `wss://host/ws?code=XXXX`.
3. Client A sends an **encrypted handshake** containing its X25519 public key.
4. User B joins the same code.
5. Client B performs the same handshake.
6. Both clients derive a shared root key and begin exchanging padded, encrypted packets.
7. All frames are relayed bidirectionally without inspection.

---

## 3. Client Architecture

### 3.1 Technology Stack

| Component     | Technology               |
|---------------|--------------------------|
| Language      | TypeScript (strict)      |
| Bundler       | Vite                     |
| Cryptography  | **Web Crypto API only** (X25519, HKDF, AES‑GCM, SHA‑256) |
| UI            | Vanilla DOM + CSS        |
| Workers       | Dedicated `cryptoWorker.ts` – all key material lives here |

### 3.2 Threading Model

- **Main thread** – UI, WebSocket I/O, state management, out‑of‑order queue.
- **Crypto Worker** – Key generation, ratchet management, encryption/decryption, padding.  
  The worker communicates with the main thread via structured `postMessage` commands.
- **No other workers** – file chunking is performed on the main thread for simplicity (files are chunked serially).

### 3.3 State Machine

```
idle → connecting → handshaking → session_ready → chatting
                            ↑            ↓
                            └── reconnecting ←┘
         (errors / disconnect → disconnected)
```

States are managed in `client/src/state/clientState.ts` and observed by the UI.

### 3.4 User Interface

The UI (`main.ts` + `ui/*`) provides:
- Session creation / joining controls.
- Security bar (fingerprint verification).
- Chat message list with timestamps.
- File attachment button.
- Modal documentation panels about encryption, privacy, and verification.

---

## 4. Server Architecture

### 4.1 Core Packages

| Package             | Responsibility                        |
|---------------------|---------------------------------------|
| `internal/session`  | In‑memory session registry (max 2 peers) |
| `internal/ws`       | WebSocket upgrade, ping/pong, relay   |
| `internal/http`     | Health endpoint, static asset serving |
| `cmd/onlytwo-server`| Entry point; wires components         |

### 4.2 Session Registry

- Sessions are indexed by a human‑readable **code** (e.g., `AX72-FE9K`).
- Each session holds up to 2 `ConnEndpoint` implementations.
- Sessions have a TTL (configurable, default 24 h) after which they are removed.
- A background goroutine periodically sweeps expired sessions.

### 4.3 WebSocket Handling

- Upgrades to WebSocket at `/ws?code=…`.
- Reads binary frames and forwards them to the **peer’s** `Send` channel.
- No parsing of the binary data — the server treats payloads as opaque.
- Connection limits: exactly 2 per session; a third attempt receives a close code `4000`.

### 4.4 Operational Behaviour

- **No persistence** – sessions live only in memory.
- **Graceful shutdown** – on `SIGTERM`/`SIGINT`, the server stops accepting new connections and drains existing ones.
- **Logging** – standard library `log` package; no message content or keys are ever logged.
- **Health check** – `GET /health` returns `{"status":"ok"}`.

---

## 5. Security Design

### 5.1 Cryptographic Primitives

OnlyTwo uses **only the Web Crypto API** with these algorithms:

| Function              | Web Crypto Algorithm          |
|-----------------------|-------------------------------|
| Key Agreement         | X25519                        |
| Key Derivation        | HKDF with SHA‑256             |
| Symmetric Encryption  | AES‑256‑GCM (authenticated)   |
| Hashing               | SHA‑256                       |

All randomness is generated via `crypto.getRandomValues`.

### 5.2 Key Hierarchy & Initial Handshake

1. Each client generates an **ephemeral X25519 identity key pair** (`IdentityKey`).
2. The public key is sent in a `HANDSHAKE` message.
3. Upon receiving the peer’s public key, both sides perform an X25519 key agreement to obtain the **shared secret**.
4. The **root key** is derived using HKDF:
   ```
   root_key = HKDF(shared_secret, salt="onlytwo-v2-root", info="root", length=32)
   ```
5. Using the root key, **sending** and **receiving chain keys** are derived with separate HKDF calls:
   - `send_chain_key = HKDF(root_key, salt=zeros(32), info="onlytwo-v2-chain-initial-send", length=32)` or `"onlytwo-v2-chain-initial-recv"` depending on lexicographic comparison of public keys (the peer with the smaller key uses the “send” info as its send chain).
6. These chain keys seed the Double Ratchet.

**Important:** The initial identity key pair also serves as the first DH ratchet key pair.  
Thus, the first DH ratchet step uses the identity keys themselves, providing a safety net without an extra exchange.

### 5.3 Double Ratchet Protocol

The protocol implements the **Double Ratchet** as described in the Signal documentation, adapted for the Web Crypto API.

#### Symmetric‑Chain Ratchet

- A **chain key** is advanced each time a message is encrypted/decrypted.
- To derive a **message key** from a chain key:
  ```
  HKDF(chain_key, salt=zeros(32), info="onlytwo-v2-chain-step", length=64)
  message_key = output[32..63]
  next_chain_key = output[0..31]
  ```
- The message key is used **exactly once** (AES‑GCM encrypt or decrypt) and then discarded.
- The chain key is replaced by `next_chain_key`.

#### Diffie‑Hellman Ratchet

- Every **50 messages** (`DH_RATCHET_INTERVAL = 50`) on the sending side, a **new X25519 key pair** is generated.
- The new public key is embedded in the next encrypted message (inside the padded plaintext, flag = 1, followed by 32 bytes of DH public key).
- The sender then performs a DH ratchet:
  1. Compute `DH(sender_new_private, peer_current_public)`.
  2. Derive new root key: `root_key = HKDF(DH_shared, old_root, info="root", length=32)`.
  3. Derive new send chain key: `send_chain_key = HKDF(new_root, zeros(32), info="onlytwo-v2-chain-active", length=32)`.
- The receiver, upon seeing the DH key flag in a decrypted payload, first extracts the DH public key, then:
  1. Computes the same DH shared secret.
  2. Derives a new root key and a new **receive** chain key.
  3. Replaces its local ratchet key pair with the received one.
- This process ensures **forward secrecy** (old keys cannot decrypt past messages) and **post‑compromise security** (a stolen key becomes stale after the next DH ratchet).

### 5.4 Message Padding & Traffic Analysis Resistance

Every plaintext before encryption is **exactly 65,536 bytes** (`PLAINTEXT_BYTES`).  
The plaintext structure:

```
[ 2 bytes big‑endian actualLength ] [ 1 byte DH flag (0 or 1) ]
[ optional 32 bytes DH public key (if flag=1) ] [ actual data ] [ random padding to fill ]
```

- `actualLength` – number of meaningful bytes in the actual data (excluding the DH key if present).
- `DH flag` – 1 if a ratchet public key is appended.
- After decryption, the recipient reads the length, strips the DH key if present, and extracts the actual data.

**Result:** All packets on the wire have identical length, defeating traffic analysis based on message size.

### 5.5 Replay Protection

Each direction maintains a **monotonic 64‑bit counter** (`BigInt`):
- `highestOutboundCounter` (sender) increments with each sent message.
- `highestInboundCounter` (receiver) processes a **consumed set**.  
- If a counter ≤ last processed counter for that direction is received, the message is **rejected** as a replay.

### 5.6 Out‑of‑Order Handling

- The receiver maintains a **skipped‑message key cache** (max 2048 entries).
- When a counter `N` is received and `N > last_applied + 1`:
  1. For each missing counter `i` in `[last_applied + 1, N-1]`, derive a message key from the current chain key, store it in the cache, and advance the chain key.
  2. Derive the message key for `N`, decrypt, and advance the chain key.
- If a late message with counter `K` arrives and `K ≤ last_applied`, look up the cached key. If found, decrypt and delete the key; otherwise, reject.
- This allows limited out‑of‑order delivery without breaking the ratchet.

### 5.7 Fingerprint Verification

After the handshake, both peers derive an **8‑character hex fingerprint** for out‑of‑band verification:

```
fingerprint = SHA‑256( lexicographically_smaller_pubkey || larger_pubkey )
             → first 4 bytes displayed in uppercase hex
```

If the fingerprints match, the connection is secure.

---

## 6. Communication Protocol

### 6.1 WebSocket Envelope Layout

All WebSocket frames are **binary** with a fixed 29‑byte header followed by the ciphertext.  
Because the ciphertext is always the result of encrypting a 65536‑byte plaintext, it is slightly larger due to AES‑GCM authentication tag (16 bytes).  
Total wire size ≈ 29 + 65536 + 16 = 65581 bytes.

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|    Type (1)   |                   Counter (8)                 |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   Timestamp (8)               |   Nonce (12)  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                    Ciphertext (variable)                      |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

**Fields**

| Field       | Size      | Description                                      |
|-------------|-----------|--------------------------------------------------|
| Type        | 1 byte    | Message type enum (see below)                    |
| Counter     | 8 bytes   | Big‑endian, per‑direction monotonic counter      |
| Timestamp   | 8 bytes   | Sender’s UTC timestamp (unused, for future)      |
| Nonce       | 12 bytes  | Random AES‑GCM IV (sent in clear)                |
| Ciphertext  | remaining | AES‑GCM encrypted payload + tag                  |

### 6.2 Plaintext Structure (Pre‑Encryption)

As described in §5.4, the plaintext is always 65536 bytes and internally contains a length prefix, DH flag, optional DH key, actual payload, and random padding.

### 6.3 Message Types

| Value  | Name        | Semantics                                  |
|--------|-------------|--------------------------------------------|
| 0x01   | `TEXT`      | Encrypted chat message                     |
| 0x02   | `MEDIA`     | Encrypted file chunk                       |
| 0x03   | `CONTROL`   | (Reserved for future control messages)     |
| 0x04   | `HANDSHAKE` | Initial key exchange (public key clear)    |

**Note:** The current implementation uses `TEXT` for file metadata (JSON inside encrypted packet). Future versions will move this to `CONTROL`.

### 6.4 Handshake Process

- Client sends `HANDSHAKE` envelope containing its 32‑byte X25519 public key.
- Nonce is set to zeros (unused).
- Upon receiving a `HANDSHAKE` with a new public key, the client invokes `ESTABLISH_SESSION` in the worker, which derives the root key and initial chains, and returns a fingerprint.
- A periodic heartbeat re‑sends the handshake until the session is established, aiding in reconnection scenarios.

---

## 7. File Transfer

### 7.1 Metadata & Chunking

- When the user selects a file, `SessionController.sendFile` first sends an **encrypted JSON** message (type `TEXT`) containing:
  ```json
  {"type":"FILE_META","name":"…","size":…,"mime":"…","totalChunks":…}
  ```
- The file is then read in **64 KiB chunks** (plaintext size after accounting for the 3‑byte header in the padded plaintext).
- Each chunk is encrypted using `ENCRYPT_BINARY` (which also pads to 65536 bytes) and sent as a `MEDIA` message.

### 7.2 Strict Sequential Queue

- File chunks are generated and sent **one at a time** in a loop with `await`.
- Any user‑typed text message while the file is in transit will be interleaved **after** the current chunk, not in a separate atomic queue.  
  *This is a known deviation from the original blueprint; a future improvement will batch file envelopes atomically before allowing further user messages.*

### 7.3 Receiver Assembly

- On `FILE_META`, the receiver initialises an internal buffer for the expected number of chunks.
- Each `MEDIA` chunk is decrypted (stripping padding) and appended.
- Progress is updated via the `onFileProgress` callback.
- When all chunks are received, the final `Blob` is assembled and exposed via `onFileReceived`.

---

## 8. Threat Model

| Threat                               | Mitigation |
|--------------------------------------|------------|
| Passive eavesdropping (TLS, Wi‑Fi)   | TLS + AES‑GCM encryption + fixed packet size |
| Malicious relay server               | End‑to‑end encryption; server never sees keys |
| Replay attacks                       | Monotonic counters + nonce |
| Tampered messages                    | AES‑GCM authentication |
| Compromised long‑term key            | Ephemeral session keys; DH ratchet forward secrecy |
| Man‑in‑the‑middle during handshake   | Out‑of‑band fingerprint verification |
| Traffic size analysis                | Uniform 64 KiB plaintext padding |

**Not protected against:** malware on the user’s device, physical observation of the screen, or sharing the session code with an attacker.

---

## 9. Deployment & Hardening

### 9.1 Production Setup

- Place the Go binary behind a reverse proxy (Caddy/Nginx) that terminates TLS with Let's Encrypt.
- Required HTTP response headers are set by the Go server:
  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  ```
- Consider adding a `Content-Security-Policy` (e.g., `default-src 'self'; worker-src 'self' blob:;`) for extra hardening.

### 9.2 Building

- Client: `cd client && npm install && npm run build`
- Server: `go build -o onlytwo-server ./cmd/onlytwo-server`
- The static handler embeds `client/dist` into the binary.

### 9.3 Configuration

Environment variables (to be expanded):
- `SESSION_TTL` – session lifetime in seconds (default 86400)
- `PORT` – listening port (default 8080)

---

## 10. Future Enhancements

- **Atomic file outbox:** Queue all file envelopes atomically before re‑enabling the text input.
- **CONTROL message type** for file metadata and future control signals.
- **Read receipts** (optional, user‑configurable).
- **Rate limiting** and Prometheus metrics.
- **Structured logging** (JSON format).
- **Client‑side file integrity verification** via `file_complete` hash (currently omitted).

---

## 11. Appendix

### 11.1 Glossary

- **Double Ratchet:** An algorithm combining symmetric‑key and DH ratchets for forward secrecy and post‑compromise security.
- **HKDF:** HMAC‑based Key Derivation Function.
- **IV (Nonce):** Initialisation vector for AES‑GCM.
- **PFS:** Perfect Forward Secrecy.

### 11.2 Security Notice

This document describes the final 1.0 protocol. All cryptographic design has been reviewed and implemented exclusively with the Web Crypto API. No third‑party crypto libraries are used.
