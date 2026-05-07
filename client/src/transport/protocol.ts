/**
 *
 * Layout: | Type (1) | Counter (8) | Timestamp (8) | Nonce (12) | Ciphertext (var) |
 *
 */

export const NONCE_SIZE = 12; // AES-GCM IV
export const HEADER_SIZE = 29; // 1 + 8 + 8 + 12

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
  const buf = new ArrayBuffer(HEADER_SIZE + env.payload.length);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  view.setUint8(0, env.type);
  view.setBigUint64(1, env.counter, false);
  view.setBigUint64(9, env.timestamp, false);
  u8.set(env.nonce, 17);
  u8.set(env.payload, HEADER_SIZE);

  return u8;
}

export function unpackEnvelope(buffer: ArrayBuffer): MessageEnvelope {
  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error(
      `Packet too small: ${buffer.byteLength} < ${HEADER_SIZE} bytes`,
    );
  }
  if (buffer.byteLength > 100 * 1024 * 1024) {
    throw new Error(`Packet too large: ${buffer.byteLength} bytes — rejected`);
  }

  const view = new DataView(buffer);

  const type = view.getUint8(0) as MessageType;
  const counter = view.getBigUint64(1, false);
  const timestamp = view.getBigUint64(9, false);

  const nonce = new Uint8Array(buffer.slice(17, 17 + NONCE_SIZE));
  const payload = new Uint8Array(buffer.slice(HEADER_SIZE));

  return { type, counter, timestamp, nonce, payload };
}

export function createEmptyNonce(): Uint8Array {
  return new Uint8Array(NONCE_SIZE);
}
