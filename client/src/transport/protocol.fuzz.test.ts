import { describe, expect, it } from "vitest";
import {
  MessageType,
  NONCE_SIZE,
  packEnvelope,
  unpackEnvelope,
} from "./protocol";

describe("protocol fuzz", () => {
  it("survives random round trips", () => {
    for (let i = 0; i < 1000; i++) {
      const payload = crypto.getRandomValues(
        new Uint8Array(Math.floor(Math.random() * 2048)),
      );

      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_SIZE));

      const env = {
        type: MessageType.TEXT,
        counter: BigInt(i),
        timestamp: BigInt(Date.now()),
        nonce,
        payload,
      };

      const packed = packEnvelope(env);
      const buffer = packed.buffer.slice(
        packed.byteOffset,
        packed.byteOffset + packed.byteLength,
      ) as ArrayBuffer;

      const unpacked = unpackEnvelope(buffer);

      expect(unpacked.counter).toBe(BigInt(i));
      expect(Array.from(unpacked.payload)).toEqual(Array.from(payload));
    }
  });

  it("rejects oversized packet", () => {
    const huge = new ArrayBuffer(101 * 1024 * 1024);

    expect(() => unpackEnvelope(huge)).toThrow(/Packet too large/);
  });
});
