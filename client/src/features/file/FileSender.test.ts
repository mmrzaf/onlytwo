import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProfile, type TransportProfile } from "../../config/profiles";
import type { AppMessage } from "../../protocol/appMessages";
import { FileSender, type SenderSnapshot } from "./FileSender";

function testProfile(): TransportProfile {
  const profile = structuredClone(getProfile("balanced"));
  profile.files.smallBytes = 0;
  profile.files.chunkBytes = 4;
  profile.files.windowChunks = 1;
  profile.files.ackTimeoutMs = 10;
  profile.files.maxRetries = 1;
  return profile;
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("FileSender", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reserves a window slot when browser backpressure rejects a chunk", async () => {
    const messages: AppMessage[] = [];
    const sender = new FileSender(
      testProfile(),
      async (message) => {
        messages.push(message);
        return message.kind !== "file.chunk";
      },
      () => undefined,
    );

    const fileId = await sender.offer(new File(["abcdefghijkl"], "sample.bin"));
    await sender.accept(fileId);
    await flushAsync();

    expect(
      messages.filter((message) => message.kind === "file.chunk"),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    await flushAsync();
    expect(
      messages.filter((message) => message.kind === "file.chunk"),
    ).toHaveLength(2);
  });

  it("fails after bounded NACK retries instead of looping forever", async () => {
    const snapshots: SenderSnapshot[] = [];
    const messages: AppMessage[] = [];
    const sender = new FileSender(
      testProfile(),
      async (message) => {
        messages.push(message);
        return true;
      },
      (snapshot) => snapshots.push(snapshot),
    );

    const fileId = await sender.offer(new File(["abcd"], "sample.bin"));
    await sender.accept(fileId);
    await flushAsync();

    sender.nack(fileId, 0, "bad chunk");
    await vi.advanceTimersByTimeAsync(400);
    await flushAsync();
    sender.nack(fileId, 0, "bad chunk again");
    await flushAsync();

    expect(snapshots.at(-1)?.status).toBe("failed");
    expect(messages.some((message) => message.kind === "file.cancel")).toBe(
      true,
    );
  });
});
