# Architecture

OnlyTwo v2 is split into strict layers.

| Layer | Responsibility |
|---|---|
| UI | Render state and collect user intent. No crypto or transport internals. |
| Session | Lifecycle, peer state, security state, feature coordination. |
| Transport | WebSocket connection, envelopes, lanes, bounded scheduling, metrics. |
| Crypto | Key exchange, message-key ratchet, encryption, decryption, safety phrase. |
| Features | Text, file streams, voice streams. |
| Server | Hardened blind relay, room registry, admission control, limits, headers. |

## Design rule

A failure in one feature must not corrupt or starve another feature. Files are reliable bulk streams. Voice is a volatile realtime stream. Text is reliable and small. Control traffic is highest priority.

## Room lifecycle

A room is created explicitly through `POST /api/rooms`. The creator selects one immutable transport profile. The relay stores that profile ID with the room. A joining or refreshed peer resolves the room through `GET /api/rooms/{code}` and uses the same profile before the encrypted handshake starts.

A normal disconnect keeps the room available for rejoin. A deliberate **End chat for both** command tombstones the room code and closes both peers. Connected rooms do not expire; the idle expiry starts after the final peer disconnects.

## Configuration rule

- Code defines canonical profiles.
- The creator selects the room profile once.
- The relay stores the immutable room profile ID.
- Both peers validate the canonical profile hash during handshake.
- Server environment variables define deployment ceilings and trust boundaries.

## Security state

Sessions move through:

1. `disconnected`
2. `connecting`
3. `encrypted_unverified`
4. `verified`
5. `ended`

The UI must not show a session as fully secure until the peers compare the safety phrase out of band.
