# OnlyTwo — Secure 1:1 Messenger

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [High‑Level Architecture](#2-high-level-architecture)
3. [Psychological Trust & User Safety Model](#3-psychological-trust--user-safety-model)
4. [Session Model](#4-session-model)
5. [Security Architecture](#5-security-architecture)
6. [Double Ratchet Protocol](#6-double-ratchet-protocol)
7. [Out‑of‑Order Message Handling](#7-out-of-order-message-handling)
8. [Message Envelope Format](#8-message-envelope-format)
9. [Control Messages](#9-control-messages)
10. [Media & File Sharing](#10-media--file-sharing)
11. [Client Architecture](#11-client-architecture)
12. [Server Architecture](#12-server-architecture)
13. [Server Operational Enhancements](#13-server-operational-enhancements)
14. [Privacy Model](#14-privacy-model)
15. [Threat Model](#15-threat-model)
16. [Deployment & Hardening](#16-deployment--hardening)
17. [User Interface Guidelines](#17-user-interface-guidelines)

---

## 1. Project Overview

**OnlyTwo** is a minimal, browser‑based real‑time messenger designed exclusively for **private conversations between exactly two people**.

**Core principles:**

- **Security must be real** – industry‑standard end‑to‑end encryption with perfect forward and post‑compromise secrecy.
- **Privacy must be verifiable** – users can independently confirm the security of their session.
- **Safety must be understandable** – clear, non‑technical language and visible trust signals.

The system runs entirely in the browser with **no installation required**. The server is a **temporary relay** that forwards encrypted packets without storing any data.

**Foundational Design Decisions:**

- **No persistence anywhere.** The client keeps no IndexedDB, localStorage, or cache of messages. Close the tab and the conversation vanishes.
- **Uniform 64 KiB packets.** Every WebSocket message—text, file chunk, or control—is padded to exactly 65,536 bytes on the wire.
- **Strict sequential sending.** A single FIFO outbox ensures that packets are transmitted in the order they are generated. No interleaving of file chunks with later text messages.
- **Minimal control traffic.** Only optional read receipts are sent; there are no delivery ACKs or typing indicators.

---

## 2. High‑Level Architecture

### 2.1 System Components

#### Client Application (Browser)

| Technology        | Purpose                                                        |
| ----------------- | -------------------------------------------------------------- |
| TypeScript + Vite | Application bundling and type safety                           |
| Libsodium.js      | All cryptographic operations (X25519, XSalsa20, BLAKE2b)       |
| Web Workers       | Off‑thread crypto, key isolation, and ratchet state protection |
| WebSocket         | Real‑time binary transport                                     |

All sensitive operations – key generation, encryption, ratchet advancement – occur **locally on the user's device**.

#### Relay Server (Go)

The server is intentionally minimal:

- Accept WebSocket connections.
- Pair two clients using a human‑readable **session code**.
- Forward opaque binary packets between the two participants.
- Enforce a **strict two‑participant limit**.
- Automatically expire idle sessions.

The server **never** stores:

- Messages (plaintext or ciphertext)
- Encryption keys
- User identities
- Metadata beyond connection duration

---

## 3. Psychological Trust & User Safety Model

Strong cryptography alone does not create trust. OnlyTwo therefore includes intentional **trust signals** and **transparency features**.

### 3.1 Clear Mental Model

The user is presented with a simple metaphor:

> _“Messages are locked on your device and sent directly to the other person. The server is only a temporary bridge that never sees what's inside.”_

### 3.2 Visible Security Indicators

- **Session Badge** – “Secure session active”
- **Encryption Status** – “Messages are encrypted before leaving your device”
- **Two‑Participant Indicator** – “Connected: 2 participants”

### 3.3 Fingerprint Verification Ritual

After the initial key exchange, both users see an **8‑character visual fingerprint** derived from the session keys.

Users are encouraged to verify this fingerprint out‑of‑band (voice call, in‑person).  
The UI explains: _“If both codes match, no one else is listening.”_

### 3.4 Transparent Data Policy

A dedicated screen explains what OnlyTwo **does not store**: messages, files, identities, keys, contacts.

### 3.5 User Control

Explicit actions are always available:

- “End secure session”
- “Clear messages from this device” (clears only the local DOM state)

---

## 4. Session Model

### 4.1 Session Code

Sessions are identified by a randomly generated, human‑readable code (e.g., `AX72-FE9K`).  
The code:

- Contains **no identity information**
- Is **unique per session**
- Exists **only while the session is active**

### 4.2 Session Constraints

- **Exactly two participants** – a third connection attempt is rejected by the server.
- **Time‑to‑live (TTL)** – configurable (default 24 hours). After expiration, the session is removed from memory.
- **Ephemeral by design** – no persistence of session state on the server.

---

## 5. Security Architecture

### 5.1 Cryptographic Primitives

| Component            | Algorithm               | Purpose                               |
| -------------------- | ----------------------- | ------------------------------------- |
| Key Agreement        | X25519                  | Initial shared secret                 |
| Key Derivation       | BLAKE2b (via libsodium) | Ratchet steps and KDF                 |
| Symmetric Encryption | XSalsa20‑Poly1305       | Message confidentiality and integrity |
| Hashing              | BLAKE2b                 | Fingerprint generation                |

### 5.2 Key Hierarchy

1. **Identity Key Pair** – X25519 long‑term key generated **per session** (ephemeral).
2. **Root Key** – Derived from the shared secret via `crypto_kx_*` session keys.
3. **Chain Keys** – For the Double Ratchet (see Section 6).
4. **Message Keys** – Derived from Chain Keys, used exactly once per message.

### 5.3 Key Expiry and Freshness

- Every new session generates a **fresh identity key pair**.
- The worker `RESET` command wipes all key material from memory.
- No keys are persisted to disk unless explicitly exported by the user (future feature).

---

## 6. Double Ratchet Protocol

OnlyTwo implements the **Double Ratchet Algorithm** as defined in the Signal Protocol, providing **forward secrecy** and **post‑compromise security**.

### 6.1 Initialization (X3DH‑style)

1. Each client generates an **identity key pair** (`IK_A`, `IK_B`) and an **ephemeral key pair** (`EK_A`, `EK_B`).
2. Public keys are exchanged via the relay.
3. Each client computes:
   ```
   DH1 = DH(IK_A.private, EK_B.public)
   DH2 = DH(EK_A.private, IK_B.public)
   DH3 = DH(EK_A.private, EK_B.public)
   shared_secret = KDF(DH1 || DH2 || DH3)
   ```
4. The **root key** and initial **sending/receiving chain keys** are derived using HKDF.

### 6.2 Symmetric Ratchet

Every message advances the **sending chain key**:

```
message_key = KDF(chain_key_send, constant="message")
chain_key_send = KDF(chain_key_send, constant="chain")
```

The **message key** is used for a single encryption operation and then discarded.

### 6.3 Diffie‑Hellman Ratchet

Periodically (every N messages or on direction change), a new DH key pair is generated and the public key is piggybacked on a message. The recipient uses it to perform a new DH computation, advancing the **root key** and resetting the chain.

### 6.4 Security Properties

- **Forward Secrecy**: Compromise of current keys does not reveal past messages.
- **Post‑Compromise Security**: After a key compromise, future messages become secure again once a new DH ratchet step occurs.
- **Replay Protection**: Monotonic counters per direction prevent message replay.

---

## 7. Out‑of‑Order Message Handling

Network latency or packet loss may cause messages to arrive out of order. OnlyTwo handles this without breaking the ratchet.

### 7.1 Skipped Message Key Cache

When a message with counter `N` is received and `N > expected_counter`:

1. For each skipped counter `i = expected_counter … N-1`:
   - Derive a **message key** from the current receiving chain key.
   - Store the message key in a **cache** indexed by counter.
   - Advance the chain key.
2. Decrypt the current message using the newly derived message key for counter `N`.

If a late message with counter `K < expected_counter` arrives:

- Look up the cached message key for counter `K`.
- If found, decrypt and delete the key.
- If not found, reject as a replay or too‑old message.

### 7.2 Cache Limits

- Maximum cache size: 2000 entries (configurable).
- Older entries are evicted (messages permanently lost).
- This is a trade‑off between memory and reliability; typical networks see minimal out‑of‑order delivery.

---

## 8. Message Envelope Format

All WebSocket frames are **binary** with a fixed header.  
**Every envelope on the wire is padded to exactly 65,536 bytes.**

### 8.1 Envelope Structure (Post‑Encryption)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|    Type (1)   |                   Counter (8)                 |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                    Nonce (24)                                 |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                    Ciphertext (65,536 bytes)                  |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

**Field Descriptions**

| Field        | Size     | Description                                          |
| ------------ | -------- | ---------------------------------------------------- |
| `Type`       | 1 byte   | Message type (see below)                             |
| `Counter`    | 8 bytes  | Monotonic counter (big‑endian) for replay protection |
| `Nonce`      | 24 bytes | Random nonce for XSalsa20‑Poly1305                   |
| `Ciphertext` | 65,536 B | Encrypted payload (always exactly 64 KiB)            |

**Message Types**

| Value  | Name        | Purpose                                      |
| ------ | ----------- | -------------------------------------------- |
| `0x01` | `TEXT`      | Text message                                 |
| `0x02` | `MEDIA`     | File chunk                                   |
| `0x03` | `CONTROL`   | Control signal (read receipt, file metadata) |
| `0x04` | `HANDSHAKE` | Initial key exchange payload                 |

### 8.2 Plaintext Structure (Before Encryption)

To achieve fixed‑size ciphertexts, the plaintext payload passed to `crypto_secretbox_easy` is **always exactly 65,536 bytes** and has the following internal layout:

```
[ Actual Length (2 bytes, big‑endian) | Payload Data (variable) | Random Padding (to 65,536) ]
```

- **Actual Length**: The number of meaningful bytes in `Payload Data` (0–65534).
- **Padding**: Generated using `libsodium.randombytes_buf`.
- **Decryption**: The recipient decrypts the entire 64 KiB, reads the first 2 bytes to determine the actual length, then discards the padding.

This ensures **indistinguishability** on the wire: an observer cannot differentiate a 10‑byte text message from a 64 KiB file chunk.

---

## 9. Control Messages

Control messages are encrypted exactly like `TEXT` and `MEDIA` messages and consume a ratchet step. They carry JSON payloads inside the ciphertext (padded to 64 KiB).

### 9.1 Read Receipt (Optional)

```json
{
  "type": "read",
  "counter": 42
}
```

Sent when the user views a message (enters the viewport). **User‑configurable** (privacy choice). If disabled, no read receipts are ever sent.

### 9.2 File Transfer Metadata

Before sending file chunks, a control message announces the file:

```json
{
  "type": "file_meta",
  "name": "image.png",
  "size": 123456,
  "mime": "image/png",
  "totalChunks": 20
}
```

### 9.3 File Transfer Completion

After all file chunks have been transmitted, a final control message provides a cryptographic hash for integrity verification:

```json
{
  "type": "file_complete",
  "hash": "b2a1c3... (hex)"
}
```

The `hash` is the **BLAKE2b digest of the entire plaintext file** (before chunking). The recipient computes the hash over the reassembled file and compares it to verify successful transfer.

### 9.4 No Delivery Acknowledgements (ACK)

OnlyTwo **does not use delivery ACKs**. There is no "delivered" indicator (double‑checkmark). The sender sees only that the envelope was handed off to the WebSocket buffer. In this ephemeral model, that is sufficient; the recipient's presence and eventual reaction are the ultimate confirmation.

---

## 10. Media & File Sharing

### 10.1 Chunking and Encryption

- Files are split into **plaintext chunks of up to 65,534 bytes** (leaving 2 bytes for the length prefix).
- Each chunk is padded to exactly 65,536 bytes using random bytes, then encrypted with the current ratchet state.
- All chunks are sent as `MEDIA` type messages.

### 10.2 Strict Sequential Queue

**The client maintains a single FIFO outbox queue.** When a file transfer is initiated:

1. The user selects a file.
2. The **Send button is temporarily disabled** and the UI shows _"Preparing file…"_.
3. The File Worker chunks and hashes the file.
4. It generates:
   - One `file_meta` control envelope (padded).
   - `N` `MEDIA` envelopes (one per chunk, padded).
   - One `file_complete` control envelope (padded).
5. All `N+2` envelopes are **appended atomically** to the outbox queue.
6. The **Send button is re‑enabled**. The user may now type and send text messages.
7. Any text message sent after the file preparation is **appended to the back of the queue**, after all file‑related envelopes.

### 10.3 Sender‑Side Progress Indication

- Progress is computed **locally** as `(bytes sent from queue) / (total bytes in queue)`.
- A progress bar is displayed on the file message row.
- If the connection drops before the queue is drained, transmission pauses. When the connection resumes, the queue continues from where it left off.
- **No per‑chunk ACKs from the receiver are needed or used.**

### 10.4 Receiver‑Side Assembly

- The receiver decrypts `file_meta` and initializes an in‑memory buffer for the expected number of chunks.
- For each received `MEDIA` chunk, the receiver:
  - Verifies the counter is within the expected range (or cached).
  - Decrypts, strips padding, and appends the plaintext data to the buffer.
  - Updates a local progress indicator.
- Upon receiving `file_complete`, the receiver computes the BLAKE2b hash of the assembled file. If it matches, the file is made available for download; otherwise, an error is shown.
- **No ACK or retransmission request is sent.** The transfer succeeds or fails silently (error shown locally). In a live conversation, the recipient will naturally indicate success or ask for a resend.

### 10.5 Cancellation

The sender may cancel an in‑progress file transfer by clicking a "Cancel" button. This:

- Removes all remaining file‑related envelopes from the outbox queue.
- Sends a `file_cancel` control message to inform the receiver to discard partial data.

---

## 11. Client Architecture

### 11.1 Technology Stack

| Component        | Technology                |
| ---------------- | ------------------------- |
| Language         | TypeScript (strict mode)  |
| Bundler          | Vite                      |
| Crypto           | libsodium‑wrappers‑sumo   |
| State Management | Reactive objects (custom) |
| UI               | Vanilla TS + CSS          |

### 11.2 Threading Model

- **Main thread** – UI, WebSocket I/O, state management, outbox queue.
- **Crypto Worker** – All key material and ratchet state live exclusively here. Encrypts/decrypts envelopes and pads plaintexts to 64 KiB.
- **File Worker** – Chunking and hashing of large files (optional; can be done in main thread for small files).

The main thread communicates with workers via **message passing**, never accessing raw keys.

### 11.3 In‑Memory Outbox Queue

```typescript
const outboxQueue: Uint8Array[] = [];
let isSending = false;
let currentSendOffset = 0;
```

- The queue holds **pre‑encrypted, padded 64 KiB envelopes** ready for WebSocket transmission.
- A send loop drains the queue sequentially. Each envelope is sent only after the previous `websocket.send()` resolves (or via `bufferedAmount` backpressure checks).
- If the WebSocket disconnects, the queue remains intact in memory. Upon reconnection, draining resumes from the next unsent envelope.
- **No persistence**: closing the tab discards the queue and all unsent data.

### 11.4 Client State Machine

```
disconnected → connecting → handshaking → session_ready → chatting
     ↑              ↓            ↓              ↓            ↓
     └──────────────┴────────────┴──────────────┴────────────┘
                     (errors / disconnect)
```

### 11.5 Hardened Web Worker Context

To further isolate the crypto worker:

- The server sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers.
- The worker is loaded as a **module** with strict origin checks.

---

## 12. Server Architecture (Go)

### 12.1 Core Components

| Package              | Responsibility                                 |
| -------------------- | ---------------------------------------------- |
| `internal/session`   | Session registry and participant management    |
| `internal/ws`        | WebSocket upgrade, read/write loops, ping/pong |
| `internal/http`      | Health checks and static asset serving         |
| `cmd/onlytwo-server` | Entry point and configuration                  |

### 12.2 Data Structures

```go
type Session struct {
    Code      string
    CreatedAt time.Time
    ExpiresAt time.Time
    conns     map[string]ConnEndpoint // max 2
}
```

- The registry holds **only active sessions** in memory.
- A background goroutine cleans up expired sessions.

### 12.3 Connection Lifecycle

1. Client connects to `/ws?code=XXXXXX`.
2. Server upgrades to WebSocket.
3. Session is retrieved or created.
4. If session already has 2 participants, connection is rejected with close code `4000`.
5. On successful join, the connection is added.
6. All binary messages are blindly forwarded to the **peer** (if present).
7. On disconnect, the connection is removed; if session becomes empty and expired, it is deleted.

### 12.4 Graceful Shutdown

- On `SIGTERM`/`SIGINT`, the server stops accepting new connections.
- All existing WebSocket connections receive a close frame with code `4001` ("Server Shutdown").
- Active sessions are allowed to drain for a configurable grace period (default 10 seconds) before forced closure.

### 12.5 Rate Limiting

- IP‑based token bucket (e.g., 10 connections per minute, 100 messages per minute).
- Prevents brute‑forcing session codes and DoS attacks.
- Limits are configurable via environment variables.

### 12.6 Connection Draining

When a session expires naturally, the server sends a close frame with code `4002` ("Session Expired") to both participants before removing the session. This gives clients a chance to display a friendly message.

---

## 13. Server Operational Enhancements

| Feature                | Description                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Metrics**            | Prometheus endpoint at `/metrics` (optional) exposing active sessions, connection counts, message throughput. |
| **Health Checks**      | `/health` returns 200 OK for load balancer probes.                                                            |
| **Structured Logging** | JSON logs for easy ingestion; **no message content or keys logged**.                                          |
| **Configuration**      | Environment variables for port, TTL, rate limits, and TLS settings.                                           |
| **Docker Support**     | Multi‑stage Dockerfile and `docker-compose.yml` provided.                                                     |

---

## 14. Privacy Model

### What the Server Can Observe

- Session codes (random strings)
- Connection IP addresses and timestamps
- Encrypted packet sizes (always 64 KiB) and timing

### What the Server Cannot Access

- Plaintext messages
- Encryption keys
- User identities
- Message metadata (type, counter are inside ciphertext)

### What Network Observers See

- Encrypted WebSocket traffic (TLS) with **uniform 64 KiB packet sizes**.
- No plaintext identifiers or size‑based traffic analysis possible.

---

## 15. Threat Model

### Protected Against

| Threat                           | Mitigation                                          |
| -------------------------------- | --------------------------------------------------- |
| Passive network surveillance     | TLS + encrypted envelope + fixed 64 KiB padding     |
| Malicious server operator        | End‑to‑end encryption; server never sees keys       |
| Replay attacks                   | Monotonic counters + nonce                          |
| Message tampering                | Poly1305 authentication                             |
| Key compromise (past messages)   | Double Ratchet forward secrecy                      |
| Key compromise (future messages) | DH ratchet post‑compromise security                 |
| Session hijacking                | Fingerprint verification + out‑of‑band confirmation |

### Not Protected Against

- Compromised user device (malware, browser extensions)
- User sharing session code with attacker
- Physical observation of screen
- Denial‑of‑service attacks on the relay server

---

## 16. Deployment & Hardening

### 16.1 Recommended Production Setup

- **Reverse Proxy**: Caddy or Nginx with automatic TLS (Let's Encrypt).
- **Security Headers**:
  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Content-Security-Policy: default-src 'self'; script-src 'self'; worker-src 'self' blob:;
  ```
- **WebSocket Compression**: Disabled (prevents CRIME/BREACH).

### 16.2 Docker Example

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY client/ ./
RUN npm ci && npm run build

FROM golang:1.24-alpine AS go-builder
WORKDIR /app
COPY . .
RUN CGO_ENABLED=0 go build -o onlytwo-server ./cmd/onlytwo-server

FROM scratch
COPY --from=go-builder /app/onlytwo-server /onlytwo-server
COPY --from=builder /app/dist /static
EXPOSE 8080
ENTRYPOINT ["/onlytwo-server"]
```

---

## 17. User Interface Guidelines

### 17.1 Connection Health Indicator

- Green dot: WebSocket connected.
- Yellow dot: Connecting.
- Red dot: Disconnected.
- Optional: display ping latency (ms).

### 17.2 Keyboard Shortcuts

| Shortcut     | Action                           |
| ------------ | -------------------------------- |
| `Ctrl+Enter` | Send message                     |
| `Escape`     | Clear input / cancel file upload |
| `Ctrl+K`     | Focus session code input         |
| `Ctrl+L`     | Clear chat history (local only)  |

### 17.3 Drag‑and‑Drop File Upload

- Drop zone highlights when dragging files over the chat area.
- Multiple files allowed; each file is processed and queued sequentially.

### 17.4 File Transfer Progress

- **Sender**: Progress bar based on `(sent bytes) / (total bytes)` from the outbox queue. Cancel button aborts the transfer.
- **Receiver**: Progress bar based on `(received chunks) / (total chunks)` from `file_meta`. Cancel button discards partial data.

### 17.5 Message Status Indicators

| Icon         | Meaning                                          |
| ------------ | ------------------------------------------------ |
| Single check | Encrypted and queued for sending (local)         |
| Filled check | Handed off to WebSocket buffer (socket accepted) |
| Blue double  | Read by recipient (if read receipts enabled)     |

No "delivered" (double‑check) indicator exists because the server cannot confirm decryption.

---

## Conclusion

This blueprint defines a **secure, private, and trustworthy** communication tool for two people. By combining a zero‑knowledge relay with the Double Ratchet protocol, strict 64 KiB padding, a single in‑memory sequential queue, and a no‑persistence philosophy, OnlyTwo delivers on its promise of **real security that users can understand and verify**.

The specification is cohesive, efficient, and ready for implementation. Every component works in harmony—like a well‑crafted mechanism with no unnecessary parts.
