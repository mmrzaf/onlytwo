import { describe, expect, it } from "vitest";
import type { AppMessage } from "./appMessages";
import { validateInboundStream } from "./streams";

const text = {
  kind: "reliable.msg",
  id: "r1",
  channel: "text",
  body: { kind: "text.message", messageId: "m1", body: "hello", createdAt: 1 },
  createdAt: 1,
  attempt: 1,
} as AppMessage;

describe("validateInboundStream", () => {
  it("accepts canonical text, file, and voice streams", () => {
    expect(() => validateInboundStream(text, 2)).not.toThrow();
    expect(() =>
      validateInboundStream(
        {
          kind: "file.chunk",
          fileId: "f1",
          index: 0,
          totalChunks: 1,
          data: "AA",
        },
        3,
      ),
    ).not.toThrow();
    expect(() =>
      validateInboundStream(
        {
          kind: "voice.frame",
          streamId: "voice",
          seq: 1,
          sentAt: 1,
          sampleRate: 48_000,
          frameMs: 40,
          pcm16: "AA",
        },
        4,
      ),
    ).not.toThrow();
  });

  it("rejects messages routed through the wrong stream", () => {
    expect(() => validateInboundStream(text, 1)).toThrow("control stream");
    expect(() =>
      validateInboundStream({ kind: "file.accept", fileId: "f1" }, 3),
    ).toThrow("file stream");
    expect(() =>
      validateInboundStream({ kind: "voice.stop", streamId: "voice" }, 4),
    ).toThrow("voice stream");
    expect(() => validateInboundStream(text, 99)).toThrow(
      "Unknown encrypted stream",
    );
  });
});
