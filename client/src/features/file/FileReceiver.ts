import type { TransportProfile } from "../../config/profiles";
import type { AppMessage } from "../../protocol/appMessages";
import { bufferFromBytes, formatBytes } from "../../utils/bytes";
import {
  decodeChunk,
  digestBlob,
  validateFilename,
  type CompletedFile,
} from "./fileProtocol";

export type ReceiverStatus =
  | "offered"
  | "receiving"
  | "completed"
  | "cancelled"
  | "failed";

export interface ReceiverSnapshot {
  fileId: string;
  name: string;
  size: number;
  receivedBytes: number;
  totalBytes: number;
  progress: number;
  status: ReceiverStatus;
  reason?: string;
  blobUrl?: string;
}

type SendApp = (message: AppMessage, lane: "control") => Promise<boolean>;
type OnUpdate = (snapshot: ReceiverSnapshot) => void;
type OnComplete = (file: CompletedFile) => void;

interface ReceiveTransfer {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  sha256?: string;
  status: ReceiverStatus;
  chunks: Array<Uint8Array | undefined>;
  received: Set<number>;
  blobUrl?: string;
  reason?: string;
}

export class FileReceiver {
  private transfers = new Map<string, ReceiveTransfer>();

  constructor(
    private profile: TransportProfile,
    private sendApp: SendApp,
    private onUpdate: OnUpdate,
    private onComplete: OnComplete,
  ) {}

  setProfile(profile: TransportProfile): void {
    this.profile = profile;
  }

  reset(): void {
    for (const transfer of this.transfers.values()) this.release(transfer);
    this.transfers.clear();
  }

  remove(fileId: string): void {
    const transfer = this.transfers.get(fileId);
    if (
      !transfer ||
      !["completed", "cancelled", "failed"].includes(transfer.status)
    )
      return;
    this.release(transfer);
    this.transfers.delete(fileId);
  }

  offer(message: Extract<AppMessage, { kind: "file.offer" }>): void {
    const name = validateFilename(message.name);
    const expectedChunks =
      message.chunkSize > 0 ? Math.ceil(message.size / message.chunkSize) : 0;
    if (
      message.size <= 0 ||
      message.size > this.profile.files.maxFileBytes ||
      message.size > this.profile.files.maxMemoryReceiveBytes
    ) {
      void this.rejectOffer(
        message.fileId,
        `File is too large for this browser (${formatBytes(message.size)})`,
      );
      return;
    }
    if (
      message.chunkSize <= 0 ||
      message.chunkSize > this.profile.files.chunkBytes ||
      message.totalChunks <= 0 ||
      message.totalChunks !== expectedChunks ||
      message.totalChunks >
        Math.ceil(
          this.profile.files.maxFileBytes / Math.max(1, message.chunkSize),
        )
    ) {
      void this.rejectOffer(message.fileId, "Invalid file metadata");
      return;
    }

    const previous = this.transfers.get(message.fileId);
    if (
      previous &&
      !["completed", "cancelled", "failed"].includes(previous.status)
    ) {
      void this.rejectOffer(message.fileId, "Duplicate active file transfer");
      return;
    }
    if (previous) {
      this.release(previous);
      this.transfers.delete(message.fileId);
    }
    const active = [...this.transfers.values()].some(
      (transfer) =>
        transfer.fileId !== message.fileId &&
        ["offered", "receiving"].includes(transfer.status),
    );
    if (active) {
      void this.rejectOffer(
        message.fileId,
        "Another incoming file transfer is already active",
      );
      return;
    }

    const transfer: ReceiveTransfer = {
      fileId: message.fileId,
      name,
      mime: message.mime || "application/octet-stream",
      size: message.size,
      chunkSize: message.chunkSize,
      totalChunks: message.totalChunks,
      sha256: message.sha256,
      status: "offered",
      chunks: new Array(message.totalChunks),
      received: new Set(),
    };
    this.transfers.set(message.fileId, transfer);
    this.emit(transfer);
  }

  async accept(fileId: string): Promise<void> {
    const transfer = this.transfers.get(fileId);
    if (!transfer || transfer.status !== "offered") return;
    transfer.status = "receiving";
    transfer.reason = undefined;
    this.emit(transfer);
    const ok = await this.sendApp(
      { kind: "file.accept", fileId },
      "control",
    ).catch(() => false);
    if (!ok) {
      transfer.status = "failed";
      transfer.reason = "Could not accept file transfer";
      this.release(transfer);
      this.emit(transfer);
    }
  }

  async reject(fileId: string, reason = "declined"): Promise<void> {
    const transfer = this.transfers.get(fileId);
    if (!transfer) return;
    transfer.status = "cancelled";
    transfer.reason = reason;
    this.release(transfer);
    this.emit(transfer);
    await this.sendApp(
      { kind: "file.reject", fileId, reason },
      "control",
    ).catch(() => false);
  }

  async cancel(
    fileId: string,
    reason = "cancelled",
    notify = true,
  ): Promise<void> {
    const transfer = this.transfers.get(fileId);
    if (!transfer) return;
    transfer.status = "cancelled";
    transfer.reason = reason;
    this.release(transfer);
    this.emit(transfer);
    if (notify)
      await this.sendApp(
        { kind: "file.cancel", fileId, reason },
        "control",
      ).catch(() => false);
  }

  async chunk(
    message: Extract<AppMessage, { kind: "file.chunk" }>,
  ): Promise<void> {
    const transfer = this.transfers.get(message.fileId);
    if (!transfer || transfer.status !== "receiving") return;
    if (
      message.totalChunks !== transfer.totalChunks ||
      message.index < 0 ||
      message.index >= transfer.totalChunks
    ) {
      await this.sendNack(
        message.fileId,
        Math.max(0, message.index),
        "invalid chunk",
      );
      return;
    }
    if (transfer.received.has(message.index)) {
      await this.sendAck(message.fileId, message.index);
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = decodeChunk(message.data);
    } catch {
      await this.sendNack(message.fileId, message.index, "invalid chunk data");
      return;
    }

    const expectedBytes =
      message.index === transfer.totalChunks - 1
        ? transfer.size - message.index * transfer.chunkSize
        : transfer.chunkSize;
    if (bytes.byteLength !== expectedBytes) {
      await this.sendNack(message.fileId, message.index, "wrong chunk size");
      return;
    }

    transfer.chunks[message.index] = bytes;
    transfer.received.add(message.index);
    await this.sendAck(message.fileId, message.index);
    this.emit(transfer);
    if (transfer.received.size === transfer.totalChunks)
      await this.complete(transfer);
  }

  completeNotice(
    message: Extract<AppMessage, { kind: "file.complete" }>,
  ): void {
    const transfer = this.transfers.get(message.fileId);
    if (!transfer || transfer.status === "completed") return;
    if (transfer.received.size !== transfer.totalChunks) {
      transfer.reason = "Waiting for missing chunks";
      this.emit(transfer);
    }
  }

  async peerCancel(
    fileId: string,
    reason = "cancelled by peer",
  ): Promise<void> {
    await this.cancel(fileId, reason, false);
  }

  private async complete(transfer: ReceiveTransfer): Promise<void> {
    try {
      const chunks = transfer.chunks.map((chunk) => {
        if (!chunk) throw new Error("Missing file chunk");
        return bufferFromBytes(chunk);
      });
      const blob = new Blob(chunks, { type: transfer.mime });
      if (blob.size !== transfer.size) throw new Error("File size mismatch");
      if (transfer.sha256 && (await digestBlob(blob)) !== transfer.sha256)
        throw new Error("Integrity check failed");
      transfer.status = "completed";
      transfer.reason = undefined;
      transfer.chunks = [];
      transfer.blobUrl = URL.createObjectURL(blob);
      this.emit(transfer);
      this.onComplete({
        fileId: transfer.fileId,
        name: transfer.name,
        mime: transfer.mime,
        size: transfer.size,
        blob,
      });
    } catch (err) {
      transfer.status = "failed";
      transfer.reason = err instanceof Error ? err.message : String(err);
      transfer.chunks = [];
      transfer.received.clear();
      this.emit(transfer);
      await this.sendApp(
        {
          kind: "file.cancel",
          fileId: transfer.fileId,
          reason: "receiver validation failed",
        },
        "control",
      ).catch(() => false);
    }
  }

  private async rejectOffer(fileId: string, reason: string): Promise<void> {
    await this.sendApp(
      { kind: "file.reject", fileId, reason },
      "control",
    ).catch(() => false);
  }

  private async sendAck(fileId: string, index: number): Promise<void> {
    await this.sendApp({ kind: "file.ack", fileId, index }, "control").catch(
      () => false,
    );
  }

  private async sendNack(
    fileId: string,
    index: number,
    reason: string,
  ): Promise<void> {
    await this.sendApp(
      { kind: "file.nack", fileId, index, reason },
      "control",
    ).catch(() => false);
  }

  private release(transfer: ReceiveTransfer): void {
    transfer.chunks = [];
    transfer.received.clear();
    if (transfer.blobUrl) {
      URL.revokeObjectURL(transfer.blobUrl);
      transfer.blobUrl = undefined;
    }
  }

  private emit(transfer: ReceiveTransfer): void {
    this.onUpdate({
      fileId: transfer.fileId,
      name: transfer.name,
      size: transfer.size,
      receivedBytes: Math.min(
        transfer.size,
        transfer.received.size * transfer.chunkSize,
      ),
      totalBytes: transfer.size,
      progress:
        transfer.totalChunks === 0
          ? 0
          : Math.min(1, transfer.received.size / transfer.totalChunks),
      status: transfer.status,
      reason: transfer.reason,
      blobUrl: transfer.blobUrl,
    });
  }
}
