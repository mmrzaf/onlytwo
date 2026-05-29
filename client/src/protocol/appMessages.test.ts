import { describe, expect, it } from "vitest";
import { decodeAppMessage, encodeAppMessage } from "./appMessages";

describe("appMessages reliable encoding", () => {
  it("round-trips reliable wrappers", () => {
    const msg = {
      kind: "reliable.msg" as const,
      id: "rel-1",
      channel: "text" as const,
      createdAt: 1,
      attempt: 2,
      body: { kind: "text.message" as const, messageId: "m1", body: "hello", createdAt: 1 }
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
      body: { kind: "voice.frame", streamId: "v", seq: 1, sentAt: 1, sampleRate: 48000, frameMs: 20, pcm16: "AA" }
    };

    expect(() => decodeAppMessage(new TextEncoder().encode(JSON.stringify(invalid)))).toThrow("Message kind is not reliable-wrappable");
  });
});
