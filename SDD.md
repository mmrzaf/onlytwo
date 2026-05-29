# System Design Document — OnlyTwo v2

**Version:** 2.0.0-draft
**Status:** Target Architecture for Refactor
**Repository:** `github.com/mmrzaf/onlytwo`
**Product:** OnlyTwo — two-person private browser messenger

---

## 0. Document Status

This document defines the target architecture for OnlyTwo v2.

It is not a claim that the current implementation already satisfies every requirement. Any feature described with **MUST** is a release requirement for v2. Any feature described with **SHOULD** is required before public release unless explicitly deferred.

OnlyTwo v2 prioritizes:

1. security correctness
2. reliable session behavior
3. stable file transfer
4. usable encrypted voice
5. simple deployability
6. honest security claims

OnlyTwo must not claim to be equivalent to Signal, audited, post-compromise secure, or resistant to all traffic analysis unless the implementation and review process actually support those claims.

---

# 1. Product Definition

## 1.1 Purpose

OnlyTwo is a browser-based, accountless, two-person private messenger.

It lets exactly two participants create a temporary encrypted session using a shared room code. The application supports:

* encrypted text chat
* encrypted file transfer
* encrypted voice chat
* out-of-band session verification
* a blind WebSocket relay server

The relay server forwards opaque packets. It does not need plaintext, message keys, file metadata, audio content, or user accounts.

## 1.2 Scope

OnlyTwo v2 consists of:

* a TypeScript browser client
* a dedicated crypto worker
* a browser audio pipeline
* a browser file-transfer pipeline
* a Go relay server
* static web hosting from the same Go binary or an external static host
* operational hardening for public internet deployment

## 1.3 Non-Goals

OnlyTwo v2 is not:

* a group messenger
* a permanent identity system
* a social network
* a cloud file-storage system
* a server-side message queue
* a replacement for audited high-risk secure messengers
* a forensic-proof anonymity system

The relay server may see IP addresses, connection timing, packet timing, packet sizes, reconnect behavior, and room-code usage unless separately protected by network-layer anonymity tools.

---

# 2. Release Targets

## 2.1 Internal Alpha

Internal alpha may ship with:

* experimental voice
* conservative file-size limits
* incomplete polish
* visible debug metrics

Internal alpha must still have:

* no plaintext server exposure
* no known build failure
* no obvious origin-bypass bug
* no uncontrolled memory blowups in normal use

## 2.2 Private Beta

Private beta requires:

* reliable text/control delivery
* bounded client queues
* WebSocket backpressure handling
* file-transfer retry, cancel, timeout, and resume behavior
* safe memory limits
* working server origin checks
* trusted proxy handling
* rate limits
* session cleanup
* accurate security documentation
* no known P0/P1 release blockers

## 2.3 Public v2

Public v2 requires:

* external crypto/protocol review or use of a recognized standard protocol construction
* complete release test matrix
* browser compatibility matrix
* operational metrics
* hardened production deployment guide
* no misleading security claims
* explicit “verified” vs “unverified” UX
* abuse controls for public internet use

---

# 3. System Overview

## 3.1 High-Level Architecture

```text
┌──────────────────┐          WSS binary frames          ┌──────────────────┐
│ Browser Client A │ ════════════════════════════════════ │ Browser Client B │
│                  │              Go relay               │                  │
│ UI               │                                      │ UI               │
│ Session runtime  │                                      │ Session runtime  │
│ Crypto worker    │                                      │ Crypto worker    │
│ File pipeline    │                                      │ File pipeline    │
│ Audio pipeline   │                                      │ Audio pipeline   │
└──────────────────┘                                      └──────────────────┘
```

The server is a rendezvous and relay component only. It pairs two connections by room code and forwards opaque binary frames.

## 3.2 Trust Boundary

Trusted:

* user’s browser runtime
* client code served to the browser
* browser Web Crypto implementation
* local device microphone/file APIs

Untrusted:

* network
* relay server
* reverse proxy
* other room occupants until verified
* browser extensions
* compromised client devices
* shared session code channels

## 3.3 Data Flow

1. User creates or enters a room code.
2. Client connects to `/ws?code=<room-code>`.
3. Server admits up to two active participants.
4. Clients perform cryptographic handshake.
5. Clients derive session keys.
6. Clients display a verification phrase.
7. Users optionally verify out-of-band.
8. Text, files, and voice are sent as encrypted application messages.
9. Reliable messages are acknowledged and retried.
10. Loss-tolerant voice frames are not retried.

---

# 4. Design Principles

## 4.1 Security Principles

* Use standard cryptographic primitives.
* Avoid custom cryptographic claims unless externally reviewed.
* Bind protocol negotiation into the handshake transcript.
* Bind session identity into AEAD associated data.
* Treat unverified sessions as encrypted but not authenticated.
* Fail closed on identity changes.
* Keep key material inside the crypto worker.
* Zeroize extractable key material where practical.
* Prefer short-lived ephemeral sessions.
* Do not log secrets, message content, file names, or room codes.

## 4.2 Reliability Principles

* Local enqueue is not delivery.
* Every important control message must be acknowledged.
* File transfer must survive packet loss, reconnects, and duplicate packets.
* Voice must tolerate packet loss without blocking other features.
* Backpressure must be explicit at every layer.
* Memory usage must be bounded by profile.
* Stuck states must timeout visibly.

## 4.3 UX Principles

* Security state must be visible.
* Verification must be understandable.
* Failure states must be actionable.
* Voice and file transfer must not silently fail.
* “Sent,” “delivered,” and “verified” must mean different things.
* Public users must not need protocol knowledge to avoid unsafe use.

---

# 5. Client Architecture

## 5.1 Main Components

```text
client/src
├── app
│   ├── App.ts
│   └── AppState.ts
├── config
│   └── profiles.ts
├── crypto
│   ├── CryptoClient.ts
│   ├── SecureChannel.ts
│   └── cryptoWorker.ts
├── features
│   ├── audio
│   ├── file
│   └── text
├── protocol
│   ├── appMessages.ts
│   ├── envelope.ts
│   ├── negotiation.ts
│   └── reliable.ts
├── runtime
│   ├── SessionRuntime.ts
│   ├── SessionQueue.ts
│   └── RuntimePolicy.ts
├── session
│   ├── SessionController.ts
│   ├── SessionStateMachine.ts
│   └── types.ts
├── transport
│   ├── WebSocketConnection.ts
│   ├── PacketScheduler.ts
│   └── metrics.ts
└── ui
    ├── AppView.ts
    └── dom.ts
```

## 5.2 Threading Model

The client uses:

| Thread               | Responsibility                                                              |
| -------------------- | --------------------------------------------------------------------------- |
| Main thread          | UI, session state, WebSocket I/O, queue orchestration                       |
| Crypto worker        | key generation, handshake operations, encryption, decryption, ratchet state |
| AudioWorklet         | microphone capture, frame slicing, optional VAD pre-processing              |
| Optional file worker | hashing and file preparation for large transfers                            |

Key material MUST remain inside the crypto worker unless browser APIs make this impossible. The main thread may hold public keys, encrypted frames, ciphertext, and plaintext application messages after decryption.

## 5.3 Session State Machine

```text
idle
  ↓
connecting
  ↓
waiting_for_peer
  ↓
handshaking
  ↓
encrypted_unverified
  ↓
verified
  ↓
closed
```

Additional transient states:

```text
reconnecting
failed
peer_changed
protocol_error
network_degraded
```

## 5.4 Security State

OnlyTwo distinguishes:

| State                      | Meaning                                                   |
| -------------------------- | --------------------------------------------------------- |
| `not_connected`            | No secure session exists                                  |
| `handshaking`              | Key agreement in progress                                 |
| `encrypted_unverified`     | Encrypted against active peer key, but MITM not ruled out |
| `verified`                 | User confirmed verification phrase out-of-band            |
| `peer_changed`             | Previously seen peer identity changed                     |
| `compromised_or_ambiguous` | Protocol state cannot be trusted                          |

In maximum-security mode, sending text/files/voice SHOULD be blocked until `verified`.

In normal mode, sending MAY be allowed in `encrypted_unverified`, but the UI MUST clearly warn that the session is not authenticated.

---

# 6. Server Architecture

## 6.1 Server Responsibilities

The Go server:

* serves static client assets or delegates static hosting
* upgrades WebSocket connections
* validates room code format
* enforces origin policy
* enforces rate limits
* enforces connection/session limits
* pairs exactly two active participants
* relays opaque binary frames
* sends ping/pong heartbeats
* cleans up expired sessions
* exposes health and metrics endpoints

The server MUST NOT:

* decrypt client payloads
* parse encrypted application messages
* store messages
* store files
* log room codes in plaintext
* log user message metadata beyond operational counters

## 6.2 Session Registry

A session is identified by a room code.

Each session contains:

```text
session_id_internal
room_code_hash
created_at
expires_at
connections[0..2]
last_activity_at
```

Room codes MUST be stored and logged only as keyed hashes or redacted values.

## 6.3 Room Code Requirements

For public v2, room codes MUST provide at least 80 bits of entropy.

Acceptable formats:

```text
XXXX-XXXX-XXXX-XXXX
```

or

```text
word-word-word-word-check
```

The code must be:

* easy to read aloud
* resistant to guessing
* validated strictly
* rate-limited by IP and by code hash

The server MUST NOT auto-create unbounded sessions for arbitrary guessed codes without rate and session limits.

## 6.4 WebSocket Handling

The server MUST use a mature WebSocket implementation or a fully RFC-compliant internal implementation.

Required behavior:

* validate `Sec-WebSocket-Version`
* validate `Sec-WebSocket-Key`
* reject unmasked client frames
* enforce binary-only frames
* enforce max frame size
* enforce read deadlines
* enforce write deadlines
* serialize writes per connection
* close slow peers instead of silently dropping critical traffic
* return clear close reasons where safe

## 6.5 Origin and Proxy Handling

Origin checks MUST be enforced before upgrade.

Allowed origins:

```text
ONLYTWO_ALLOWED_ORIGINS=https://example.com,https://www.example.com
```

If no allowed origins are configured in production, startup SHOULD fail.

IP detection MUST use trusted proxy configuration.

The server MUST NOT trust arbitrary `X-Forwarded-For`.

Required config:

```text
ONLYTWO_TRUSTED_PROXIES=127.0.0.1,10.0.0.0/8
ONLYTWO_ALLOWED_ORIGINS=https://onlytwo.example
```

If the request does not come from a trusted proxy, the remote socket address is authoritative.

## 6.6 Abuse Controls

The server MUST enforce:

* max connections per IP
* max sessions per IP
* max session creation rate per IP
* max join attempts per room code
* max frame size
* max idle connection time
* max session TTL
* global connection cap
* global session cap

The server SHOULD expose metrics for rejected joins, rejected origins, rate limits, active sessions, active connections, dropped sends, and close reasons.

---

# 7. Cryptographic Design

## 7.1 Security Target

OnlyTwo v2 targets:

* confidentiality against passive network observers
* integrity against message tampering
* replay protection
* forward secrecy for completed message keys
* clear MITM detection through user verification
* optional peer identity continuity
* minimized metadata leakage under practical browser constraints

OnlyTwo v2 does not claim:

* anonymity
* malware resistance
* protection after both endpoints are compromised
* audited Signal-equivalent security unless externally reviewed
* full traffic-analysis resistance in efficient modes

## 7.2 Cryptographic Primitives

Preferred browser-native profile:

| Function      | Primitive                |
| ------------- | ------------------------ |
| Key agreement | X25519                   |
| KDF           | HKDF-SHA-256             |
| AEAD          | AES-256-GCM              |
| Hash          | SHA-256                  |
| Randomness    | `crypto.getRandomValues` |

If a reviewed WASM crypto package is adopted, the approved profile MAY use:

| Function      | Primitive              |
| ------------- | ---------------------- |
| Key agreement | X25519                 |
| AEAD          | XChaCha20-Poly1305     |
| Hash/KDF      | BLAKE3 or HKDF-SHA-256 |
| Signatures    | Ed25519                |

The chosen profile MUST be documented, versioned, and test-vector covered.

## 7.3 Handshake Requirement

The handshake MUST provide:

* ephemeral key agreement
* transcript binding
* downgrade protection
* profile negotiation binding
* session ID derivation
* verification phrase derivation
* key confirmation

Recommended construction:

```text
Noise-style two-party handshake using X25519
+
application transcript hash
+
short authentication string for user verification
```

If a full Noise implementation is used, the selected pattern MUST be documented exactly.

For anonymous accountless sessions, the default model is:

* encrypted session establishment
* no automatic authentication
* user verification phrase detects MITM
* optional trusted peer identity persistence after user approval

## 7.4 Session Keys

The crypto worker derives:

```text
handshake_secret
transcript_hash
root_key
send_chain_key
recv_chain_key
header_key_send
header_key_recv
session_id
verification_secret
```

The session ID is not a user identifier. It is a cryptographic binding value derived from handshake material and used in AEAD associated data.

## 7.5 Message Encryption

Every encrypted application message uses:

```text
message_key = KDF(chain_key)
next_chain_key = KDF(chain_key)
ciphertext = AEAD_Encrypt(message_key, nonce, plaintext, aad)
```

Each message key MUST be used once.

After use:

* message key is zeroized where practical
* chain key advances
* counter increments
* consumed inbound counters are tracked with bounded memory

## 7.6 Ratchet Model

OnlyTwo v2 has two acceptable release paths.

### Path A — Symmetric Ratchet Only

Private beta may use:

* one authenticated handshake
* send/receive symmetric chains
* per-message keys
* replay protection
* out-of-order skipped-key cache

Claims allowed:

* end-to-end encrypted
* per-message keys
* forward secrecy for deleted message keys

Claims not allowed:

* Double Ratchet
* post-compromise recovery
* Signal-equivalent security

### Path B — Double Ratchet

Public v2 SHOULD implement or adopt a reviewed Double Ratchet design.

Required properties:

* DH ratchet steps
* symmetric sending and receiving chains
* skipped message key cache
* bounded out-of-order window
* identity-change handling
* transcript-bound verification
* test vectors
* protocol review

Claims allowed only after implementation and review:

* Double Ratchet
* post-compromise recovery after ratchet healing
* stronger forward secrecy

## 7.7 AEAD Associated Data

Every encrypted frame MUST bind:

```text
protocol_version
crypto_profile_id
session_id
session_epoch
direction
counter
lane
message_type
reliable_message_id if present
file_id if present
voice_stream_id if present
```

AAD prevents ciphertext from being replayed into another session, lane, message type, or protocol version.

## 7.8 Replay Protection

Each receiving direction maintains:

```text
highest_inbound_counter
consumed_counter_window
skipped_message_keys
```

Rules:

* duplicate counters are rejected
* counters too far ahead are rejected
* skipped-key cache has a strict size limit
* consumed counter tracking is bounded
* failed decrypts do not advance state unless protocol explicitly allows it

## 7.9 Verification Phrase

The verification phrase MUST be derived from:

```text
protocol version
crypto profile
transcript hash
both public handshake keys
optional persistent identity keys
session code hash
feature negotiation
```

The phrase SHOULD use words, not hex, for human comparison.

Example:

```text
river copper lunar stone anchor prism
```

The UI MUST explain:

* matching phrase means no active MITM was present during verification
* mismatched phrase means stop using the session
* unverified encrypted sessions are still vulnerable to MITM

## 7.10 Key Persistence

Default mode:

* no account
* no long-term identity
* no persistent private keys
* session keys destroyed on close/reload

Optional trusted-peer mode:

* user explicitly saves peer identity
* future sessions warn on identity change
* local storage must be clearly documented
* private identity keys, if added, must be protected as much as browser storage permits

---

# 8. Wire Protocol

## 8.1 Frame Classes

Wire frames are binary.

Outer frame classes:

| Class       | Meaning                                |
| ----------- | -------------------------------------- |
| `HANDSHAKE` | handshake negotiation                  |
| `DATA`      | encrypted application data             |
| `CLOSE`     | optional protocol close                |
| `PING`      | optional app-level heartbeat if needed |

The relay treats all valid binary frames as opaque and forwards them to the peer.

## 8.2 Envelope Requirements

The envelope MUST include enough cleartext data for parsing and cryptographic routing, but no application metadata unless required.

Recommended clear header:

```text
magic
protocol_version
frame_class
header_length
session_epoch
counter
nonce
payload_length
```

Application fields such as text/file/voice message kind SHOULD be encrypted inside the payload.

## 8.3 Padding Profiles

OnlyTwo v2 uses configurable padding profiles.

| Profile           | Behavior                                        |
| ----------------- | ----------------------------------------------- |
| `maximum_privacy` | fixed-size frames and optional constant cadence |
| `balanced`        | bucketed padding                                |
| `low_data`        | smaller buckets, more metadata leakage          |
| `voice_first`     | low-latency voice with bounded privacy tradeoff |

Padding MUST be applied before encryption.

The UI SHOULD expose the tradeoff plainly:

* maximum privacy uses more bandwidth
* low data leaks more size/timing information
* VAD voice leaks speaking activity

## 8.4 Protocol Versioning

Every protocol version must define:

```text
protocol_version
crypto_profile_id
frame format
message schema
reliability behavior
file-transfer behavior
voice behavior
migration behavior
```

Clients MUST reject unsupported versions instead of silently downgrading.

---

# 9. Application Message Protocol

## 9.1 Message Categories

Encrypted application messages are categorized as:

| Category  | Reliability           | Examples                                   |
| --------- | --------------------- | ------------------------------------------ |
| Control   | Reliable              | session verified, file accept, file cancel |
| Text      | Reliable              | chat messages                              |
| File data | Transfer reliable     | chunks, range ACKs                         |
| Voice     | Loss tolerant         | audio frames                               |
| Metrics   | Local only by default | queue depth, jitter, loss                  |

## 9.2 Reliable Message Wrapper

All important control and text messages MUST use a reliable wrapper.

```ts
type ReliableMessage = {
  kind: "reliable.msg";
  id: string;
  channel: "control" | "text";
  createdAt: number;
  attempt: number;
  body: AppMessage;
};
```

Acknowledgement:

```ts
type ReliableAck = {
  kind: "reliable.ack";
  id: string;
};
```

Negative acknowledgement:

```ts
type ReliableNack = {
  kind: "reliable.nack";
  id: string;
  reason: string;
};
```

## 9.3 Reliable Delivery Rules

Sender:

* assigns globally unique message ID
* stores message in pending map
* sends immediately when encrypted session exists
* retries with exponential backoff
* fails visibly after max attempts

Receiver:

* validates message ID
* deduplicates repeated IDs
* processes first valid copy once
* ACKs every valid copy, including duplicates
* rejects invalid messages with NACK where useful

## 9.4 Retry Policy

Default retry policy:

```text
initial retry: 1500 ms
backoff: 2x
max delay: 12000 ms
max attempts: 5
jitter: ±20%
```

After failure, UI state becomes:

```text
failed_delivery
```

The user may retry manually.

## 9.5 Text Message States

Text messages use:

| State       | Meaning                       |
| ----------- | ----------------------------- |
| `draft`     | local input only              |
| `queued`    | waiting for session/transport |
| `sending`   | encrypted and scheduled       |
| `delivered` | peer ACK received             |
| `failed`    | retries exhausted             |
| `received`  | inbound message accepted      |

The UI MUST NOT label a message as delivered before receiving ACK.

---

# 10. Transport and Queueing

## 10.1 Client Queueing

The client has separate logical lanes:

```text
control
voice
text
file
```

Priority order:

```text
control > voice > text > file
```

The scheduler MUST prevent starvation. File transfer must yield to text/control/voice.

## 10.2 Backpressure

Backpressure must be enforced at:

1. application pending queue
2. encryption queue
3. packet scheduler
4. browser WebSocket buffer
5. server send channel
6. peer receive loop

The client MUST check `WebSocket.bufferedAmount`.

When `bufferedAmount` exceeds profile limit:

* pause draining
* keep queues bounded
* resume when below threshold
* update UI/network state if prolonged

## 10.3 Queue Limits

Each profile defines:

```text
max_outbox_packets
max_outbox_bytes
max_lane_packets
max_lane_bytes
max_browser_buffered_bytes
```

Voice may drop old frames.

Control/text must not silently drop. They either remain pending, retry, or fail visibly.

File chunks may be retried by the file-transfer protocol.

## 10.4 Reconnect Behavior

On disconnect:

* voice frames are dropped
* reliable control/text remain pending
* file transfers pause
* session state becomes `reconnecting`
* crypto session is preserved only if reconnecting to same verified peer
* changed peer identity causes hard failure

On reconnect:

* handshake/key confirmation runs again
* pending reliable messages retry
* file transfer resumes from receiver ranges
* voice requires explicit restart or stream resume

---

# 11. File Transfer Design

## 11.1 Goals

File transfer must be:

* encrypted end-to-end
* bounded in memory
* resumable after reconnect
* cancellable by either side
* integrity-checked
* resistant to duplicate/lost/reordered chunks
* clear in UI

## 11.2 File Control Messages

Reliable file control messages:

```ts
type FileOffer = {
  kind: "file.offer";
  fileId: string;
  name: string;
  mime: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  fileHash?: string;
  hashAlgorithm?: "sha256" | "blake3";
};

type FileAccept = {
  kind: "file.accept";
  fileId: string;
};

type FileReject = {
  kind: "file.reject";
  fileId: string;
  reason: string;
};

type FileCancel = {
  kind: "file.cancel";
  fileId: string;
  reason: string;
};

type FileComplete = {
  kind: "file.complete";
  fileId: string;
  fileHash?: string;
};
```

These MUST be sent through the reliable message wrapper.

## 11.3 File Data Messages

File chunks are transfer-reliable, not generic reliable messages.

```ts
type FileChunk = {
  kind: "file.chunk";
  fileId: string;
  index: number;
  offset: number;
  totalChunks: number;
  data: string;
  chunkHash?: string;
};
```

Acknowledgement SHOULD use ranges:

```ts
type FileAckRange = {
  kind: "file.ack.range";
  fileId: string;
  receivedThrough: number;
  missing?: number[];
};
```

Explicit NACK:

```ts
type FileNack = {
  kind: "file.nack";
  fileId: string;
  index: number;
  reason: string;
};
```

## 11.4 Sender State Machine

```text
idle
  ↓
offering
  ↓
accepted
  ↓
sending
  ↓
paused
  ↓
resuming
  ↓
completed

failure states:
rejected
cancelled
timed_out
failed_integrity
failed_transport
```

Rules:

* offer retries if no accept/reject
* transfer starts only after accept
* sender maintains sliding window
* sender retries missing chunks
* sender pauses on backpressure
* sender stops immediately on cancel
* sender fails visibly on retry exhaustion

## 11.5 Receiver State Machine

```text
idle
  ↓
offered
  ↓
accepted
  ↓
receiving
  ↓
assembling
  ↓
verifying
  ↓
completed

failure states:
rejected
cancelled
failed_integrity
failed_storage
failed_protocol
```

Rules:

* receiver validates file metadata before accept
* receiver rejects files above profile limit
* receiver rejects unsafe filenames after sanitization
* receiver tracks received ranges
* receiver writes chunks to selected sink
* receiver verifies final hash when provided
* receiver cleans partial data on cancel/failure unless user chooses otherwise

## 11.6 Storage Strategy

OnlyTwo v2 defines a `FileSink` abstraction:

```ts
interface FileSink {
  writeChunk(index: number, offset: number, bytes: Uint8Array): Promise<void>;
  hasChunk(index: number): boolean;
  receivedRanges(): Array<[number, number]>;
  finalize(): Promise<Blob | FileSystemFileHandle>;
  abort(): Promise<void>;
}
```

Implementations:

| Sink                   | Use                                              |
| ---------------------- | ------------------------------------------------ |
| `MemoryFileSink`       | small files only                                 |
| `OPFSFileSink`         | large browser-managed temporary files            |
| `FileSystemAccessSink` | direct user-approved disk writes where supported |

Large files MUST NOT require holding every chunk in RAM.

## 11.7 File Size Limits

Default private beta limits:

| Profile           | Max file size |
| ----------------- | ------------- |
| `low_data`        | 25 MB         |
| `balanced`        | 50 MB         |
| `voice_first`     | 50 MB         |
| `maximum_privacy` | 25 MB         |

Public v2 may raise limits only after streaming sinks and stress tests pass.

## 11.8 Hashing

For files above small-memory threshold, hashing MUST be incremental.

Acceptable approaches:

* incremental SHA-256 implementation
* BLAKE3 WASM
* per-chunk hash tree with final root hash

Do not compute large-file hash by loading the entire Blob into memory.

---

# 12. Voice Design

## 12.1 Goals

Voice chat must be:

* encrypted end-to-end
* low latency
* non-blocking for text/control
* resilient to packet loss
* bounded in CPU and memory
* honest about privacy tradeoffs

## 12.2 Voice Modes

OnlyTwo v2 supports two voice privacy modes.

### Efficient Voice Mode

* uses VAD
* sends packets only when speech is detected
* lower bandwidth
* lower CPU
* leaks speaking activity through timing

### Maximum Privacy Voice Mode

* sends fixed cadence packets
* sends encrypted silence or comfort-noise frames when user is silent
* higher bandwidth
* better traffic-shape privacy
* should be default in `maximum_privacy` profile

## 12.3 Voice Activity Detection

Efficient mode uses VAD with:

```text
RMS level
adaptive noise floor
start threshold
stop threshold
pre-roll
hangover
```

Default values:

```text
vad_start_db: -45 dB
vad_stop_db: -52 dB
pre_roll_ms: 120
hangover_ms: 250
min_speech_ms: 60
noise_floor_adaptive: true
```

The system MUST NOT use a raw one-frame volume gate without pre-roll and hangover because it clips syllables.

## 12.4 Voice Packet Types

```ts
type VoiceStart = {
  kind: "voice.start";
  streamId: string;
  codec: "pcm16" | "opus";
  sampleRate: number;
  frameMs: number;
  mode: "efficient" | "maximum_privacy";
};

type VoiceFrame = {
  kind: "voice.frame";
  streamId: string;
  seq: number;
  sentAt: number;
  codec: "pcm16" | "opus";
  sampleRate: number;
  frameMs: number;
  payload: string;
};

type VoiceStop = {
  kind: "voice.stop";
  streamId: string;
};
```

`voice.start` and `voice.stop` MUST be reliable control messages.

`voice.frame` MUST NOT be retried.

## 12.5 Codec Strategy

Private beta may use PCM16 if simple and stable.

Public v2 SHOULD use Opus if browser support and implementation quality are acceptable.

Preferred:

```text
Opus mono
20 ms frames
16 kHz or 24 kHz
adaptive bitrate
```

Fallback:

```text
PCM16 mono
16 kHz
20 ms frames
```

## 12.6 Jitter Buffer

Receiver uses a jitter buffer with:

* sequence ordering
* late packet drop
* target playout delay
* adaptive jitter estimate
* silence insertion for missing frames
* packet loss metric

Voice must never block reliable control/text processing.

## 12.7 Voice Backpressure

If crypto or WebSocket queues are congested:

* drop old unsent voice frames
* never queue stale voice beyond configured latency
* update voice quality metrics
* keep control/text reliable messages intact

Maximum queued voice latency:

```text
balanced: 400 ms
voice_first: 250 ms
maximum_privacy: fixed cadence, bounded 500 ms
```

---

# 13. UI/UX Requirements

## 13.1 Security Bar

The UI MUST always show:

* connection state
* encryption state
* verification state
* peer identity status
* profile/privacy mode

Example states:

```text
Disconnected
Waiting for peer
Encrypted — not verified
Verified
Peer identity changed — stop
Reconnecting
```

## 13.2 Verification UX

Verification must be prominent and simple.

The UI shows:

```text
Compare this phrase with your peer over another channel:
river copper lunar stone anchor prism
```

Actions:

* “Verified — phrases match”
* “Mismatch — end session”
* “Skip for now”

If skipped, the session remains visibly `encrypted_unverified`.

## 13.3 Text UX

Messages show:

* queued
* sending
* delivered
* failed
* retry action if failed

No message should show delivered unless peer ACK was received.

## 13.4 File UX

File cards show:

* offered
* waiting for accept
* accepted
* sending
* receiving
* paused
* retrying
* verifying
* completed
* failed
* cancelled

For large files, UI must warn if browser storage support is limited.

## 13.5 Voice UX

Voice UI shows:

* microphone permission state
* active stream state
* local level meter
* peer speaking indicator
* packet loss/jitter warning
* privacy mode indicator

Efficient voice mode should clearly state:

```text
Efficient mode sends audio only when speech is detected. This reduces bandwidth but reveals speaking timing.
```

---

# 14. Configuration Profiles

## 14.1 Profile Fields

Each transport profile defines:

```ts
type TransportProfile = {
  id: string;
  protocolVersion: number;
  cryptoProfile: string;
  maxFrameBytes: number;
  paddingBuckets: number[];
  outbox: {
    maxPackets: number;
    maxBytes: number;
    maxBufferedAmountBytes: number;
    resumeBufferedAmountBytes: number;
  };
  lanes: Record<LaneName, LaneBudget>;
  files: {
    maxFileBytes: number;
    chunkSize: number;
    windowSize: number;
    maxInFlightBytes: number;
    ackTimeoutMs: number;
    maxRetries: number;
  };
  voice: {
    enabled: boolean;
    mode: "efficient" | "maximum_privacy";
    codec: "pcm16" | "opus";
    sampleRate: number;
    frameMs: number;
    vadEnabled: boolean;
    vadStartDb: number;
    vadStopDb: number;
    preRollMs: number;
    hangoverMs: number;
    maxQueuedLatencyMs: number;
  };
  reconnect: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterMs: number;
  };
};
```

## 14.2 Required Profiles

OnlyTwo v2 SHOULD define:

| Profile           | Purpose                                             |
| ----------------- | --------------------------------------------------- |
| `balanced`        | default                                             |
| `low_data`        | smaller frames, lower bandwidth                     |
| `voice_first`     | lower latency voice                                 |
| `maximum_privacy` | fixed padding/cadence, stronger metadata resistance |

The selected profile must be negotiated and bound into the handshake transcript.

---

# 15. Deployment and Hardening

## 15.1 Required Production Settings

Production deployments MUST configure:

```text
ONLYTWO_ADDR
ONLYTWO_ALLOWED_ORIGINS
ONLYTWO_SESSION_TTL_SECONDS
ONLYTWO_MAX_FRAME_BYTES
ONLYTWO_RATE_LIMIT_PER_MINUTE
ONLYTWO_MAX_SESSIONS_PER_IP
ONLYTWO_MAX_CONNECTIONS_PER_IP
ONLYTWO_TRUSTED_PROXIES
ONLYTWO_CSP
```

Missing production-critical settings SHOULD fail startup.

## 15.2 HTTP Security Headers

Required:

```text
Content-Security-Policy
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
X-Frame-Options: DENY or frame-ancestors 'none'
Permissions-Policy
```

If cross-origin isolation is needed for future audio/codec/WASM behavior:

```text
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

## 15.3 CSP Baseline

Recommended baseline:

```text
default-src 'self';
script-src 'self';
worker-src 'self' blob:;
connect-src 'self' wss:;
img-src 'self' blob: data:;
media-src 'self' blob:;
style-src 'self';
object-src 'none';
base-uri 'none';
frame-ancestors 'none';
form-action 'none';
```

Inline styles should be removed before strict public release where practical.

## 15.4 Logging

Logs may include:

* event type
* redacted IP or keyed IP hash
* close reason
* timing
* counters
* error codes

Logs MUST NOT include:

* plaintext messages
* file names
* file hashes unless explicitly safe
* room codes
* public keys unless redacted
* verification phrases
* ciphertext payloads

## 15.5 Metrics

Required metrics:

```text
active_sessions
active_connections
session_creations_total
session_expired_total
ws_upgrades_total
ws_rejected_origin_total
ws_rejected_rate_limit_total
ws_rejected_code_total
relay_frames_total
relay_bytes_total
relay_send_failures_total
connection_close_reasons_total
```

Client-side debug metrics:

```text
queued_packets
queued_bytes
reconnects
reliable_pending
reliable_failed
file_transfer_rate
file_retries
voice_dropped_frames
voice_jitter_ms
voice_packet_loss
```

---

# 16. Threat Model

## 16.1 Protected Against

| Threat                          | Mitigation                       |
| ------------------------------- | -------------------------------- |
| Passive network observer        | TLS + E2EE                       |
| Malicious relay reading content | client-side encryption           |
| Message tampering               | AEAD authentication              |
| Replay attacks                  | counters + replay window         |
| Lost control messages           | reliable wrapper + ACK/retry     |
| File corruption                 | AEAD + file hash                 |
| Stale voice frames              | lossy voice queue + drop policy  |
| Room guessing                   | high-entropy codes + rate limits |
| Cross-site WebSocket abuse      | strict origin checks             |

## 16.2 Partially Protected

| Threat                               | Limitation                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------- |
| MITM during first session            | detected only if users verify phrase                                        |
| Traffic analysis                     | reduced by padding, not eliminated except partially in maximum privacy mode |
| Malicious peer                       | cannot be prevented after user joins same room                              |
| Browser compromise                   | out of scope                                                                |
| Host compromise serving malicious JS | requires supply-chain/deployment controls                                   |

## 16.3 Not Protected Against

OnlyTwo does not protect against:

* malware on endpoint
* malicious browser extensions
* screen recording
* microphone compromise
* user sharing room code with attacker
* server denying service
* global passive adversary correlating traffic timing
* compromised static asset deployment

---

# 17. Testing Requirements

## 17.1 Unit Tests

Required:

* room code validation
* origin validation
* trusted proxy parsing
* rate limiter
* session registry
* envelope pack/unpack
* AAD generation
* reliable ACK/retry logic
* duplicate suppression
* file range ACK logic
* VAD state machine
* jitter buffer

## 17.2 Integration Tests

Required:

* two clients connect and handshake
* text delivery with ACK
* dropped ACK retry
* duplicate reliable message
* reconnect after disconnect
* peer identity change detection
* file offer lost/retried
* file accept lost/retried
* file transfer interrupted/resumed
* file cancel sender-side
* file cancel receiver-side
* voice start/stop reliable
* voice frame drop under congestion

## 17.3 Browser Tests

Required browsers:

* Chrome latest
* Firefox latest
* Safari latest where supported
* iOS Safari if mobile is a target
* Android Chrome if mobile is a target

Required scenarios:

* microphone permission denied
* tab backgrounded
* network offline/online
* reload during session
* large file memory pressure
* slow peer
* high packet loss
* high latency
* mobile low-memory behavior

## 17.4 Security Tests

Required:

* invalid origin rejected
* spoofed XFF ignored unless trusted proxy
* invalid WebSocket key rejected
* unmasked client frame rejected
* frame over size limit rejected
* replayed encrypted frame rejected
* wrong session AAD rejected
* wrong lane/message type AAD rejected
* changed peer key fails hard
* downgrade attempt rejected
* malformed app message rejected

---

# 18. Documentation Requirements

Public documentation MUST state:

* OnlyTwo is end-to-end encrypted.
* The relay cannot read message contents.
* Verification is required to rule out MITM.
* Efficient voice mode leaks speaking timing.
* Maximum privacy mode uses more bandwidth.
* The app does not provide anonymity by itself.
* Browser/device compromise is out of scope.
* Security claims depend on the current protocol version.

Documentation MUST NOT claim:

* audited security unless audited
* Double Ratchet unless implemented
* post-compromise security unless implemented
* perfect traffic-analysis resistance
* server cannot collect metadata
* verified identity without user verification

---

# 19. Implementation Roadmap

## Phase 1 — Correctness Baseline

* fix fresh build/test path
* fix server origin enforcement
* fix trusted proxy IP handling
* enforce connection/session limits
* replace or harden WebSocket implementation
* add cleanup loops
* correct documentation claims

## Phase 2 — Reliable Messaging

* add reliable wrapper
* add ACK/NACK
* add retry queue
* add duplicate suppression
* add visible delivery states
* add WebSocket `bufferedAmount` backpressure

## Phase 3 — Stable File Transfer

* add conservative file caps
* make offer/accept/cancel/complete reliable
* add timeout and retry
* add range ACKs
* add resumable state
* add streaming file sinks
* add incremental hashing

## Phase 4 — Voice Stabilization

* add VAD with pre-roll/hangover
* add maximum privacy constant cadence mode
* improve jitter buffer
* add packet loss/jitter metrics
* prevent voice from blocking text/control
* evaluate Opus

## Phase 5 — Crypto Upgrade

* finalize protocol construction
* add transcript-bound session ID
* add stronger verification phrase
* add optional trusted identity continuity
* implement Double Ratchet only if fully specified and tested
* produce test vectors
* get external protocol review before public v2 claims

## Phase 6 — Public Release Hardening

* complete browser matrix
* complete deployment guide
* add metrics
* add abuse monitoring
* add security review checklist
* run load tests
* run file/voice soak tests
* publish accurate security model

---

# 20. Release Gate

OnlyTwo v2 is public-release ready only when all are true:

```text
fresh checkout builds
all tests pass
origin checks enforced
trusted proxy handling correct
server limits enforced
no silent control/text drops
reliable text/control implemented
file transfer bounded and resumable
large files do not require full RAM buffering
voice has VAD and/or privacy cadence mode
crypto claims match implementation
verification UX is clear
docs are accurate
deployment guide is complete
security review completed
```

Until then, release classification is:

```text
current refactor target: internal alpha
after phases 1-4: private beta candidate
after phases 5-6: public v2 candidate
```

---

# 21. Glossary

| Term                  | Meaning                                                |
| --------------------- | ------------------------------------------------------ |
| AEAD                  | Authenticated encryption with associated data          |
| AAD                   | Metadata authenticated but not encrypted               |
| VAD                   | Voice activity detection                               |
| Jitter buffer         | Audio receive buffer that smooths network timing       |
| MITM                  | Man-in-the-middle attacker                             |
| OPFS                  | Origin Private File System                             |
| Relay                 | Server that forwards encrypted frames                  |
| Reliable message      | Message requiring ACK/retry                            |
| Loss-tolerant message | Message where stale retry is harmful, e.g. voice frame |
| Verification phrase   | Human-readable short authentication string             |
| Maximum privacy mode  | Higher-bandwidth mode that reduces metadata leakage    |

---

# 22. Final Security Notice

OnlyTwo v2 is designed as a secure, minimal, two-person encrypted messenger.

Its security depends on:

* correct client delivery
* correct cryptographic implementation
* honest verification UX
* hardened server admission
* safe deployment
* accurate documentation
* independent review before strong public claims

The relay server is blind to message contents, but it is not blind to metadata. Users who require anonymity must use additional network-layer protections.

OnlyTwo must prefer accurate security boundaries over marketing claims.

