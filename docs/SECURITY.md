# Security Notes

## Threat model

OnlyTwo protects message contents from the relay and network observers. It does not hide that two clients connect to the relay. Traffic-analysis resistance depends on the selected profile.

## Verification

The relay can relay substituted public keys during the initial exchange. Users must compare the safety code out-of-band to detect a man-in-the-middle attack.

## Browser hardening

The server sends a strict Content Security Policy and related security headers. The UI avoids inserting untrusted text through `innerHTML`.

## Custom crypto warning

The client uses WebCrypto with X25519, HKDF-SHA-256, and AES-256-GCM plus a message-key ratchet. This is a custom protocol implementation and must be externally audited before high-risk use.

## Metadata

Transport header fields are authenticated as AEAD associated data for encrypted frames where applicable. The relay still sees frame size, timing, and connection metadata. Maximum Privacy profile reduces some metadata leakage at significant bandwidth cost.
