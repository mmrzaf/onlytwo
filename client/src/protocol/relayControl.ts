const MAGIC_A = 0x4f; // O
const MAGIC_B = 0x52; // R
const VERSION = 1;
const FRAME_BYTES = 4;

enum RelayControlType {
  PEER_PRESENT = 1,
  PEER_DISCONNECTED = 2,
  PEER_REJOINED = 3,
  SESSION_END = 4,
  SESSION_ENDED = 5,
}

export type RelayEvent =
  | { kind: "peer.present" }
  | { kind: "peer.disconnected" }
  | { kind: "peer.rejoined" }
  | { kind: "session.ended" };

export function encodeSessionEndCommand(): Uint8Array {
  return encode(RelayControlType.SESSION_END);
}

export function decodeRelayEvent(buffer: ArrayBuffer): RelayEvent | null {
  const type = decodeType(new Uint8Array(buffer));
  switch (type) {
    case RelayControlType.PEER_PRESENT:
      return { kind: "peer.present" };
    case RelayControlType.PEER_DISCONNECTED:
      return { kind: "peer.disconnected" };
    case RelayControlType.PEER_REJOINED:
      return { kind: "peer.rejoined" };
    case RelayControlType.SESSION_ENDED:
      return { kind: "session.ended" };
    case null:
    case RelayControlType.SESSION_END:
      return null;
  }
}

export function isRelayControlFrame(buffer: ArrayBuffer): boolean {
  return decodeType(new Uint8Array(buffer)) !== null;
}

function encode(type: RelayControlType): Uint8Array {
  return Uint8Array.of(MAGIC_A, MAGIC_B, VERSION, type);
}

function decodeType(bytes: Uint8Array): RelayControlType | null {
  if (bytes.byteLength !== FRAME_BYTES) return null;
  if (bytes[0] !== MAGIC_A || bytes[1] !== MAGIC_B || bytes[2] !== VERSION)
    return null;
  const type = bytes[3];
  if (
    type < RelayControlType.PEER_PRESENT ||
    type > RelayControlType.SESSION_ENDED
  )
    return null;
  return type as RelayControlType;
}
