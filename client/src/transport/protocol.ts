// | Type (1) | Counter (8) | Timestamp (8) | Nonce (24) | Ciphertext (variable) |
export const HEADER_SIZE = 41;

export enum MessageType {
  TEXT = 0x01,
  MEDIA = 0x02,
  CONTROL = 0x03,
  HANDSHAKE = 0x04,
}

export interface MessageEnvelope {
  type: MessageType;
  counter: bigint;
  timestamp: bigint;
  nonce: Uint8Array;
  payload: Uint8Array;
}

export function packEnvelope(env: MessageEnvelope): Uint8Array {
  const buffer = new ArrayBuffer(HEADER_SIZE + env.payload.length);
  const view = new DataView(buffer);
  const uint8View = new Uint8Array(buffer);

  // 1. Type (1 byte)
  view.setUint8(0, env.type);

  // 2. Counter (8 bytes) - Big Endian
  view.setBigUint64(1, env.counter, false);

  // 3. Timestamp (8 bytes) - Big Endian
  view.setBigUint64(9, env.timestamp, false);

  // 4. Nonce (24 bytes)
  uint8View.set(env.nonce, 17);

  // 5. Payload / Ciphertext (Variable)
  uint8View.set(env.payload, HEADER_SIZE);

  return uint8View;
}

export function unpackEnvelope(buffer: ArrayBuffer): MessageEnvelope {
  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error("Invalid packet: smaller than header size");
  }
  if (buffer.byteLength > 100 * 1024 * 1024) {
    throw new Error("Invalid packet: Payload exceeds maximum safe size");
  }

  const view = new DataView(buffer);
  const type = view.getUint8(0);
  const counter = view.getBigUint64(1, false);
  const timestamp = view.getBigUint64(9, false);

  const nonce = new Uint8Array(buffer, 17, 24);
  const payload = new Uint8Array(buffer, HEADER_SIZE);

  return { type, counter, timestamp, nonce, payload };
}

// Utility to create empty nonces for unencrypted system/handshake messages
export function createEmptyNonce(): Uint8Array {
  return new Uint8Array(24);
}
