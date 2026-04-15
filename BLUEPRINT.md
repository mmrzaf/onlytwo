# OnlyTwo — Secure 1:1 Messenger Blueprint

---

# 1. Project Overview

**OnlyTwo** is a minimal browser‑based real‑time messenger designed for **private conversations between exactly two people**.

The system prioritizes:

- Strong end‑to‑end encryption
- Anonymous sessions (no accounts)
- Zero server storage
- Media sharing
- Perfect forward secrecy
- Replay protection
- Operation inside restrictive or censored networks
- **Clear, confidence‑building user experience**

The system runs entirely in the browser with **no installation required**.

The server functions only as a **temporary relay**, forwarding encrypted packets between two clients without storing any data.

### Design Philosophy

OnlyTwo is built around three principles:

1. **Security must be real**
2. **Privacy must be verifiable**
3. **Safety must be understandable**

The application avoids technical jargon and instead communicates security using **clear, human language and visible signals of protection**.

---

# 2. High-Level Architecture

## 2.1 System Components

### Client Application (Browser)

Technology stack:

- TypeScript + Vite
- Libsodium.js cryptography
- Web Workers for crypto operations
- WebSocket for transport

Responsibilities:

- Encryption & decryption
- Key generation
- Ratchet updates
- UI rendering
- Trust verification

All sensitive operations happen **locally on the user's device**.

---

### Relay Server (Go)

The server is intentionally minimal.

Responsibilities:

- Accept WebSocket connections
- Pair two clients using a session code
- Forward encrypted packets

The server:

- stores **no messages**
- stores **no keys**
- stores **no identities**
- keeps **no logs**

The server simply acts as a **temporary wire** between two devices.

---

# 3. Psychological Trust & User Safety Model

Strong cryptography alone does not make users feel safe.  
OnlyTwo therefore includes **intentional trust signals and transparency features**.

## 3.1 Clear Mental Model

Users should understand the system with a simple idea:

> “Messages are locked on your device and sent directly to the other person.”

The server is described as:

> “A temporary connection bridge that never stores messages.”

Avoiding technical jargon helps reduce fear and confusion.

---

## 3.2 Visible Security Indicators

The interface continuously communicates the security state.

Examples:

- **Secure Session Badge**
  - “Secure connection active”

- **Encryption Status**
  - “Messages are encrypted before leaving your device”

- **Two‑Participant Indicator**
  - “Connected: 2 participants”

These small indicators reassure users without requiring technical knowledge.

---

## 3.3 Fingerprint Verification Ritual

After the initial key exchange, both users see a short verification code:

Example:

```
 Security Code

apple-river-sunset-mirror
```

Users are encouraged to confirm the code via a trusted channel (voice call or in person).

UI explanation:

> “If both codes match, no one else is listening.”

This creates a **simple human verification ritual** that protects against MITM attacks.

---

## 3.4 Transparent Data Policy Screen

OnlyTwo includes a clear screen explaining what the system **does NOT store**.

Example section:

**OnlyTwo does NOT store:**

- messages
- photos or files
- usernames
- phone numbers
- contacts
- encryption keys

This transparency builds confidence and reduces suspicion.

---

## 3.6 User Control Over Data

Users always feel in control through visible actions:

- “End secure session”
- “Clear messages from this device”

Control reduces anxiety and increases trust.

---

## 3.7 Calm, Non‑Threatening Language

The application avoids words that create fear such as:

- database
- persistence
- storage engine

Instead it uses language like:

- “secure connection”
- “private session”

This keeps the experience calm and approachable.

---

# 4. Session Model

## 4.1 Session Code

Sessions are created using a human‑readable code:

```
AX72-FE9K
```

This code is used only to **connect two participants**.

The code:

- contains no identity information
- is randomly generated
- exists only during the session

---

## 4.2 Session Constraints

Each session supports:

- exactly **two participants**
- no additional users

If a third connection attempts to join:

- the server rejects the connection

Sessions also have a **time‑to‑live** (example: 24 hours).

After expiration:

- the server removes the session from memory.

---

# 5. Security Architecture

## 5.1 Key Types

Each participant generates locally:

Long‑term key pair

```
X25519 public/private key
```

Used for initial key agreement.

---

Session symmetric key

```
32 byte symmetric key
```

Used for message encryption.

---

Message nonce

```
24 byte random value
```

Used once per message.

---

# 6. Handshake Process

1. Both clients generate X25519 key pairs
2. Public keys are exchanged via the relay
3. Clients compute a shared secret

```
shared = ECDH(privateA, publicB)
```

4. Initial encryption key derived:

```
K0 = HKDF(shared, sessionCode)
```

5. A fingerprint is generated:

```
fingerprint = SHA256(pubA || pubB)
```

6. The UI presents a short verification code to users.

If both users confirm the code matches, the connection is verified.

---

# 7. Forward Secrecy Ratchet

After every message the encryption key is updated.

Sending message:

```
counter++
ciphertext = encrypt(K_current, plaintext)
K_current = SHA256(K_current)
```

Receiving message:

```
verify counter > lastCounter
plaintext = decrypt(K_current)
K_current = SHA256(K_current)
```

Benefits:

- forward secrecy
- replay attack prevention
- message ordering validation

---

# 8. Message Envelope Format

All WebSocket traffic is binary.

Envelope structure:

```
| Type | Counter | Timestamp | Nonce | Ciphertext |
```

Fields:

Type (1 byte)

```
0x01 text
0x02 media chunk
0x03 control event
0x04 handshake/system
```

Counter

```
uint64 monotonic counter
```

Timestamp

Used only for UI display.

Nonce

24 byte random value.

Ciphertext

Encrypted message payload.

---

# 9. Media Sharing

Files are split into fixed‑size chunks.

Default chunk size:

```
64 KB
```

Every chunk uses the same encrypted envelope structure as text messages.

Network observers cannot distinguish between:

- text
- images
- video
- files

All traffic appears identical.

---

# 10. Client Architecture

Technology stack:

- TypeScript
- Vite
- Web Workers
- Libsodium.js
- WebSocket

Client state machine:

```
disconnected
connecting
handshaking
session_ready
chatting
```

---

# 11. Server Architecture (Go)

The server is a minimal WebSocket relay.

Responsibilities:

- accept connections
- match session codes
- relay encrypted frames
- enforce two‑user limit
- expire sessions

Server never stores:

- messages
- identities
- encryption keys

Data structures:

```
map[string]*Session
```

Each session holds two connections only.

---

# 12. Privacy Model

The server can observe:

- session codes
- connection timing
- encrypted packet sizes

The server cannot access:

- messages
- media
- encryption keys
- message metadata
- participant identities

---

# 13. Threat Model

The system protects against:

- network surveillance
- malicious server operators
- replay attacks
- passive traffic monitoring
- compromised server logs

The system does not protect against:

- compromised user devices
- malicious browser extensions
- users sharing session codes with attackers
