import { describe, expect, it } from "vitest";
import {
  createEmptyNonce,
  HEADER_SIZE,
  MessageType,
  NONCE_SIZE,
  packEnvelope,
  unpackEnvelope,
} from "./protocol";

describe("protocol", () => {
  it("packs and unpacks envelopes", () => {
    const env = {
      type: MessageType.TEXT,
      counter: 9n,
      timestamp: 123n,
      nonce: new Uint8Array(NONCE_SIZE).fill(7),
      payload: new Uint8Array([1, 2, 3]),
    };

    const packed = packEnvelope(env);
    const buffer = packed.buffer.slice(
      packed.byteOffset,
      packed.byteOffset + packed.byteLength,
    ) as ArrayBuffer;

    const unpacked = unpackEnvelope(buffer);

    expect(unpacked.type).toBe(MessageType.TEXT);
    expect(unpacked.counter).toBe(9n);
    expect(unpacked.timestamp).toBe(123n);
    expect(Array.from(unpacked.payload)).toEqual([1, 2, 3]);
  });

  it("rejects undersized packets", () => {
    expect(() => {
      unpackEnvelope(new ArrayBuffer(HEADER_SIZE - 1));
    }).toThrow();
  });

  it("creates zero nonce", () => {
    const nonce = createEmptyNonce();

    expect(nonce.length).toBe(NONCE_SIZE);
    expect(Array.from(nonce).every((v) => v === 0)).toBe(true);
  });
});
