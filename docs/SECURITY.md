# Security Notes

## Threat model

OnlyTwo protects message contents from the relay and network observers. It does not hide that two clients connect to the relay. Traffic-analysis resistance depends on the creator-selected room profile.

## Verification

The relay can relay substituted public keys during the initial exchange. Users must compare the safety phrase out of band to detect a man-in-the-middle attack. A refresh or rejoin creates a fresh cryptographic epoch and requires verification again.

## Blind relay metadata

The relay stores the room code, immutable profile ID, participant-slot metadata, timestamps, and connection metadata. It forwards opaque encrypted application frames. It does not receive message text, file contents, voice PCM, or the safety phrase.

## Browser hardening

The server sends a strict Content Security Policy and related security headers. The UI avoids inserting untrusted text through `innerHTML`. Peer messages are bounded and validated before reaching feature state. Encrypted message kinds are constrained to their authenticated transport streams.

## Reverse proxies

`ONLYTWO_TRUSTED_PROXIES` must contain only reverse-proxy IP addresses or CIDRs controlled by the operator. Forwarded client-IP headers are ignored unless the immediate connection comes from a configured trusted proxy.

## Custom crypto warning

The client uses WebCrypto with X25519, HKDF-SHA-256, and AES-256-GCM plus a message-key ratchet. This is a custom protocol implementation and must be externally audited before high-risk use.

## Metadata

Transport header fields are authenticated as AEAD associated data for encrypted frames where applicable. The relay still sees frame size, timing, and connection metadata. The Maximum Privacy profile reduces some metadata leakage at significant bandwidth cost.
