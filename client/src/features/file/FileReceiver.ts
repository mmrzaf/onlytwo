import type { TransportProfile } from "../../config/profiles";
import type { AppMessage } from "../../protocol/appMessages";
import {
  decodeChunk,
  digestBlob,
  validateFilename,
  type CompletedFile,
} from "./fileProtocol";
import { bufferFromBytes, formatBytes } from "../../utils/bytes";
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

  offer(message: Extract<AppMessage, { kind: "file.offer" }>): void {
    const name = validateFilename(message.name);
    if (
      message.size <= 0 ||
      message.size > this.profile.files.maxFileBytes ||
      message.size > this.profile.files.maxMemoryReceiveBytes
    ) {
      void this.sendApp(
        {
          kind: "file.reject",
          fileId: message.fileId,
          reason: `File is too large for this browser (${formatBytes(message.size)})`,
        },
        "control",
      );
      return;
    }
    if (
      message.totalChunks <= 0 ||
      message.totalChunks >
        Math.ceil(
          this.profile.files.maxFileBytes / Math.max(1, message.chunkSize),
        )
    ) {
      void this.sendApp(
        {
          kind: "file.reject",
          fileId: message.fileId,
          reason: "Invalid file metadata",
        },
        "control",
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
    this.emit(transfer);
    await this.sendApp({ kind: "file.accept", fileId }, "control");
  }

  async reject(fileId: string, reason = "declined"): Promise<void> {
    const transfer = this.transfers.get(fileId);
    if (!transfer) return;
    transfer.status = "cancelled";
    transfer.reason = reason;
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
    transfer.chunks = [];
    transfer.received.clear();
    if (transfer.blobUrl) URL.revokeObjectURL(transfer.blobUrl);
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
      await this.sendApp(
        {
          kind: "file.nack",
          fileId: message.fileId,
          index: Math.max(0, message.index),
          reason: "invalid chunk",
        },
        "control",
      ).catch(() => false);
      return;
    }
    if (transfer.received.has(message.index)) {
      await this.sendApp(
        { kind: "file.ack", fileId: message.fileId, index: message.index },
        "control",
      ).catch(() => false);
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeChunk(message.data);
    } catch {
      await this.sendApp(
        {
          kind: "file.nack",
          fileId: message.fileId,
          index: message.index,
          reason: "invalid chunk data",
        },
        "control",
      ).catch(() => false);
      return;
    }
    if (
      bytes.byteLength > transfer.chunkSize ||
      (message.index < transfer.totalChunks - 1 &&
        bytes.byteLength !== transfer.chunkSize)
    ) {
      await this.sendApp(
        {
          kind: "file.nack",
          fileId: message.fileId,
          index: message.index,
          reason: "wrong chunk size",
        },
        "control",
      ).catch(() => false);
      return;
    }
    transfer.chunks[message.index] = bytes;
    transfer.received.add(message.index);
    await this.sendApp(
      { kind: "file.ack", fileId: message.fileId, index: message.index },
      "control",
    ).catch(() => false);
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
      if (transfer.sha256) {
        const digest = await digestBlob(blob);
        if (digest !== transfer.sha256)
          throw new Error("Integrity check failed");
      }
      transfer.status = "completed";
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
      this.emit(transfer);
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
