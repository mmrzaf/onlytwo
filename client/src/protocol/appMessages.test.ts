import { describe, expect, it } from "vitest";
import {
  APP_VERSION,
  decodeAppMessage,
  decodeHandshake,
  encodeAppMessage,
  encodeHandshake,
} from "./appMessages";

describe("appMessages reliable encoding", () => {
  it("round-trips reliable wrappers", () => {
    const msg = {
      kind: "reliable.msg" as const,
      id: "rel-1",
      channel: "text" as const,
      createdAt: 1,
      attempt: 2,
      body: {
        kind: "text.message" as const,
        messageId: "m1",
        body: "hello",
        createdAt: 1,
      },
    };

    expect(decodeAppMessage(encodeAppMessage(msg))).toEqual(msg);
  });

  it("rejects generic reliable wrappers around lossy messages", () => {
    const invalid = {
      kind: "reliable.msg",
      id: "rel-1",
      channel: "control",
      createdAt: 1,
      attempt: 1,
      body: {
        kind: "voice.frame",
        streamId: "v",
        seq: 1,
        sentAt: 1,
        sampleRate: 48000,
        frameMs: 20,
        pcm16: "AA",
      },
    };

    expect(() =>
      decodeAppMessage(new TextEncoder().encode(JSON.stringify(invalid))),
    ).toThrow("Message kind is not reliable-wrappable");
  });
});

describe("appMessages validation", () => {
  it("accepts canonical room-profile handshakes", () => {
    const handshake = {
      kind: "handshake.v2" as const,
      publicKey: "AQID",
      profileId: "voice_first" as const,
      profileHash: "a".repeat(32),
      appVersion: APP_VERSION,
      featureFlags: ["room.profile.v1"],
    };
    expect(decodeHandshake(encodeHandshake(handshake))).toEqual(handshake);
  });

  it("rejects invalid profile handshakes and malformed peer payloads", () => {
    const invalidHandshake = {
      kind: "handshake.v2",
      publicKey: "AQID",
      profileId: "unknown",
      profileHash: "a".repeat(32),
      appVersion: "x",
      featureFlags: [],
    };
    expect(() =>
      decodeHandshake(
        new TextEncoder().encode(JSON.stringify(invalidHandshake)),
      ),
    ).toThrow("Invalid room profile");

    const oversizedText = {
      kind: "text.message",
      messageId: "m1",
      body: "x".repeat(8_001),
      createdAt: 1,
    };
    expect(() =>
      decodeAppMessage(new TextEncoder().encode(JSON.stringify(oversizedText))),
    ).toThrow("Invalid string: body");

    const fractionalChunk = {
      kind: "file.chunk",
      fileId: "f1",
      index: 0.5,
      totalChunks: 1,
      data: "AA",
    };
    expect(() =>
      decodeAppMessage(
        new TextEncoder().encode(JSON.stringify(fractionalChunk)),
      ),
    ).toThrow("Invalid integer: index");
  });
});
