import type { LaneName, TransportProfile } from "../config/profiles";

export const MAGIC_A = 0x4f; // O
export const MAGIC_B = 0x54; // T
export const HEADER_BYTES = 38;
export const AAD_BYTES = 34;
export const NONCE_BYTES = 12;

export enum OuterType {
  HANDSHAKE = 1,
  DATA = 2
}

export interface AadContext {
  protocolVersion: number;
  outerType: OuterType;
  flags: number;
  streamId: number;
  sequence: number;
}

export interface Envelope extends AadContext {
  counter: bigint;
  nonce: Uint8Array;
  payload: Uint8Array;
  lane: LaneName;
}

export function createAadContext(env: Pick<Envelope, "outerType" | "flags" | "streamId" | "sequence">, profile: TransportProfile): AadContext {
  return {
    protocolVersion: profile.protocolVersion,
    outerType: env.outerType,
    flags: env.flags,
    streamId: env.streamId,
    sequence: env.sequence
  };
}

export function encodeAad(context: AadContext, counter: bigint, nonce: Uint8Array): Uint8Array {
  if (nonce.byteLength !== NONCE_BYTES) throw new Error("Invalid nonce length");
  const out = new Uint8Array(AAD_BYTES);
  const view = new DataView(out.buffer);
  view.setUint8(0, MAGIC_A);
  view.setUint8(1, MAGIC_B);
  view.setUint8(2, context.protocolVersion);
  view.setUint8(3, context.outerType);
  view.setUint8(4, context.flags & 0xff);
  view.setUint8(5, HEADER_BYTES);
  view.setUint32(6, context.streamId >>> 0, false);
  view.setUint32(10, context.sequence >>> 0, false);
  view.setBigUint64(14, counter, false);
  out.set(nonce, 22);
  return out;
}

export function packEnvelope(env: Envelope, profile: TransportProfile): Uint8Array {
  if (env.nonce.byteLength !== NONCE_BYTES) throw new Error("Invalid nonce length");
  if (env.protocolVersion !== profile.protocolVersion) throw new Error("Protocol/profile mismatch");
  if (env.outerType !== OuterType.HANDSHAKE && env.outerType !== OuterType.DATA) throw new Error("Invalid envelope type");

  const total = HEADER_BYTES + env.payload.byteLength;
  if (total > profile.maxFrameBytes) throw new Error(`Frame too large: ${total} > ${profile.maxFrameBytes}`);

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint8(0, MAGIC_A);
  view.setUint8(1, MAGIC_B);
  view.setUint8(2, profile.protocolVersion);
  view.setUint8(3, env.outerType);
  view.setUint8(4, env.flags & 0xff);
  view.setUint8(5, HEADER_BYTES);
  view.setUint32(6, env.streamId >>> 0, false);
  view.setUint32(10, env.sequence >>> 0, false);
  view.setBigUint64(14, env.counter, false);
  out.set(env.nonce, 22);
  view.setUint32(34, env.payload.byteLength, false);
  out.set(env.payload, HEADER_BYTES);
  return out;
}

export function unpackEnvelope(buffer: ArrayBuffer, profile: TransportProfile): Envelope {
  if (buffer.byteLength < HEADER_BYTES) throw new Error("Frame too small");
  if (buffer.byteLength > profile.maxFrameBytes) throw new Error("Frame too large");

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (view.getUint8(0) !== MAGIC_A || view.getUint8(1) !== MAGIC_B) throw new Error("Invalid frame magic");

  const protocolVersion = view.getUint8(2);
  if (protocolVersion !== profile.protocolVersion) throw new Error(`Unsupported protocol version: ${protocolVersion}`);

  const outerType = view.getUint8(3);
  if (outerType !== OuterType.HANDSHAKE && outerType !== OuterType.DATA) throw new Error("Unknown frame type");

  const flags = view.getUint8(4);
  if (flags !== 0) throw new Error("Reserved frame flags set");

  const headerLen = view.getUint8(5);
  if (headerLen !== HEADER_BYTES) throw new Error("Invalid frame header length");

  const payloadLen = view.getUint32(34, false);
  if (payloadLen + HEADER_BYTES !== buffer.byteLength) throw new Error("Invalid frame payload length");

  return {
    protocolVersion,
    outerType,
    flags,
    streamId: view.getUint32(6, false),
    sequence: view.getUint32(10, false),
    counter: view.getBigUint64(14, false),
    nonce: bytes.slice(22, 34),
    payload: bytes.slice(HEADER_BYTES),
    lane: outerType === OuterType.HANDSHAKE ? "control" : "text"
  };
}
