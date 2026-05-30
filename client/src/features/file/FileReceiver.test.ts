import { describe, expect, it, vi } from "vitest";
import { getProfile } from "../../config/profiles";
import type { AppMessage } from "../../protocol/appMessages";
import { FileReceiver, type ReceiverSnapshot } from "./FileReceiver";

function offer(fileId: string): Extract<AppMessage, { kind: "file.offer" }> {
  return {
    kind: "file.offer",
    fileId,
    name: `${fileId}.bin`,
    mime: "application/octet-stream",
    size: 4,
    chunkSize: 4,
    totalChunks: 1,
  };
}

describe("FileReceiver", () => {
  it("rejects a second active inbound transfer", () => {
    const messages: AppMessage[] = [];
    const receiver = new FileReceiver(
      getProfile("balanced"),
      async (message) => {
        messages.push(message);
        return true;
      },
      () => undefined,
      () => undefined,
    );

    receiver.offer(offer("file-one"));
    receiver.offer(offer("file-two"));

    expect(messages).toContainEqual({
      kind: "file.reject",
      fileId: "file-two",
      reason: "Another incoming file transfer is already active",
    });
  });

  it("fails visibly when the accept control message cannot be queued", async () => {
    const snapshots: ReceiverSnapshot[] = [];
    const receiver = new FileReceiver(
      getProfile("balanced"),
      async () => false,
      (snapshot) => snapshots.push(snapshot),
      vi.fn(),
    );

    receiver.offer(offer("file-one"));
    await receiver.accept("file-one");

    expect(snapshots.at(-1)).toEqual(
      expect.objectContaining({
        fileId: "file-one",
        status: "failed",
        reason: "Could not accept file transfer",
      }),
    );
  });
});
