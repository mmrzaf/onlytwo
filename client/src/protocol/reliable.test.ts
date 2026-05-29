import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReliableChannel, shouldSendReliably } from "./reliable";
import type { AppMessage } from "./appMessages";
import type { LaneName } from "../config/profiles";

function text(id = "msg-1"): AppMessage {
  return { kind: "text.message", messageId: id, body: "hello", createdAt: 1 };
}

describe("ReliableChannel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(crypto, "randomUUID").mockReturnValue("rel-1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("wraps reliable text messages and resolves on ack", async () => {
    const sent: Array<{ message: AppMessage; lane: LaneName }> = [];
    const delivered = vi.fn();

    const channel = new ReliableChannel({
      send: async (message, lane) => {
        sent.push({ message, lane });
        return true;
      },
      onDelivered: delivered
    }, { initialRetryMs: 100, jitterRatio: 0 });

    await expect(channel.send(text(), "text", { trackingId: "msg-1" })).resolves.toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0].lane).toBe("text");
    expect(sent[0].message).toMatchObject({
      kind: "reliable.msg",
      id: "rel-1",
      channel: "text",
      attempt: 1
    });

    await channel.receive({ kind: "reliable.ack", id: "rel-1" });

    expect(channel.pendingCount).toBe(0);
    expect(delivered).toHaveBeenCalledWith("rel-1", "msg-1");
  });

  it("retries until ack or max attempts", async () => {
    const sent: AppMessage[] = [];
    const failed = vi.fn();

    const channel = new ReliableChannel({
      send: async (message) => {
        sent.push(message);
        return true;
      },
      onFailed: failed
    }, { initialRetryMs: 100, maxRetryMs: 1000, backoffFactor: 2, maxAttempts: 3, jitterRatio: 0 });

    await channel.send(text(), "text", { trackingId: "msg-1" });
    expect(sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ kind: "reliable.msg", attempt: 2 });

    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ kind: "reliable.msg", attempt: 3 });

    await vi.advanceTimersByTimeAsync(400);
    expect(channel.pendingCount).toBe(0);
    expect(failed).toHaveBeenCalledWith("rel-1", "msg-1", "Message delivery timed out");
  });

  it("acks duplicates but returns the body only once", async () => {
    const sent: AppMessage[] = [];
    const duplicates = vi.fn();

    const channel = new ReliableChannel({
      send: async (message) => {
        sent.push(message);
        return true;
      },
      onDuplicate: duplicates
    });

    const inbound: AppMessage = {
      kind: "reliable.msg",
      id: "peer-1",
      channel: "text",
      createdAt: 1,
      attempt: 1,
      body: { kind: "text.message", messageId: "m1", body: "hi", createdAt: 1 }
    };

    await expect(channel.receive(inbound)).resolves.toEqual(inbound.body);
    await expect(channel.receive(inbound)).resolves.toBeNull();

    expect(sent).toEqual([
      { kind: "reliable.ack", id: "peer-1" },
      { kind: "reliable.ack", id: "peer-1" }
    ]);
    expect(duplicates).toHaveBeenCalledWith("peer-1");
  });

  it("does not mark file chunks, file ACKs, or voice frames as generic reliable messages", () => {
    expect(shouldSendReliably(text(), "text")).toBe(true);
    expect(shouldSendReliably({ kind: "file.accept", fileId: "f1" }, "control")).toBe(true);
    expect(shouldSendReliably({ kind: "file.ack", fileId: "f1", index: 0 }, "control")).toBe(false);
    expect(shouldSendReliably({ kind: "file.chunk", fileId: "f1", index: 0, totalChunks: 1, data: "AA" }, "file")).toBe(false);
    expect(shouldSendReliably({ kind: "voice.frame", streamId: "v", seq: 1, sentAt: 1, sampleRate: 48000, frameMs: 20, pcm16: "AA" }, "voice")).toBe(false);
  });
});
