import type { TransportProfile } from "../../config/profiles";
import type { AppMessage } from "../../protocol/appMessages";
import { makeId } from "../../utils/ids";
import {
  digestBlob,
  encodeChunk,
  validateFilename,
  validateOutboundFile,
} from "./fileProtocol";

export type SenderStatus =
  | "queued"
  | "offered"
  | "sending"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export interface SenderSnapshot {
  fileId: string;
  name: string;
  size: number;
  sentBytes: number;
  totalBytes: number;
  progress: number;
  status: SenderStatus;
  reason?: string;
}

type SendApp = (
  message: AppMessage,
  lane: "control" | "file",
) => Promise<boolean>;
type OnUpdate = (snapshot: SenderSnapshot) => void;
type ChunkState = "sending" | "waiting_ack" | "retry_wait";

interface InflightChunk {
  attempts: number;
  state: ChunkState;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Transfer {
  file: File;
  fileId: string;
  name: string;
  mime: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  sha256?: string;
  status: SenderStatus;
  accepted: boolean;
  paused: boolean;
  cancelled: boolean;
  pumping: boolean;
  nextIndex: number;
  acked: Set<number>;
  inflight: Map<number, InflightChunk>;
  reason?: string;
}

export class FileSender {
  private transfers = new Map<string, Transfer>();
  private globalPaused = false;

  constructor(
    private profile: TransportProfile,
    private sendApp: SendApp,
    private onUpdate: OnUpdate,
  ) {}

  setProfile(profile: TransportProfile): void {
    this.profile = profile;
  }

  reset(): void {
    for (const transfer of this.transfers.values()) this.clearTimers(transfer);
    this.transfers.clear();
    this.globalPaused = false;
  }

  remove(fileId: string): void {
    const transfer = this.transfers.get(fileId);
    if (
      !transfer ||
      !["completed", "cancelled", "failed"].includes(transfer.status)
    )
      return;
    this.clearTimers(transfer);
    this.transfers.delete(fileId);
  }

  setGlobalPaused(paused: boolean, reason = "paused"): void {
    this.globalPaused = paused;
    for (const transfer of this.transfers.values()) {
      if (transfer.status !== "sending" && transfer.status !== "paused")
        continue;
      transfer.paused = paused;
      transfer.status = paused ? "paused" : "sending";
      transfer.reason = paused ? reason : undefined;
      if (paused) this.holdOutstanding(transfer);
      this.emit(transfer);
      if (!paused) this.resumeOutstanding(transfer);
    }
  }

  async offer(file: File, queued = false): Promise<string> {
    validateOutboundFile(file, this.profile);
    const fileId = makeId("file");
    const chunkSize = this.profile.files.chunkBytes;
    const totalChunks = Math.ceil(file.size / chunkSize);
    const transfer: Transfer = {
      file,
      fileId,
      name: validateFilename(file.name),
      mime: file.type || "application/octet-stream",
      size: file.size,
      chunkSize,
      totalChunks,
      status: queued ? "queued" : "offered",
      accepted: false,
      paused: queued,
      cancelled: false,
      pumping: false,
      nextIndex: 0,
      acked: new Set(),
      inflight: new Map(),
      reason: queued
        ? "Waiting for earlier work"
        : "Waiting for peer acceptance",
    };
    if (file.size <= this.profile.files.smallBytes) {
      try {
        transfer.sha256 = await digestBlob(file);
      } catch {
        transfer.sha256 = undefined;
      }
    }
    this.transfers.set(fileId, transfer);
    this.emit(transfer);
    if (!queued) await this.sendOffer(transfer);
    return fileId;
  }

  async startQueued(fileId: string): Promise<void> {
    const transfer = this.transfers.get(fileId);
    if (!transfer || transfer.cancelled || transfer.status !== "queued") return;
    transfer.status = "offered";
    transfer.paused = false;
    transfer.reason = "Waiting for peer acceptance";
    this.emit(transfer);
    await this.sendOffer(transfer);
  }

  async accept(fileId: string): Promise<void> {
    const transfer = this.transfers.get(fileId);
    if (!transfer || transfer.cancelled) return;
    transfer.accepted = true;
    transfer.status = this.globalPaused ? "paused" : "sending";
    transfer.paused = this.globalPaused;
    transfer.reason = this.globalPaused ? "Paused during voice" : undefined;
    this.emit(transfer);
    await this.pump(transfer);
  }

  ack(fileId: string, index: number): void {
    const transfer = this.transfers.get(fileId);
    if (
      !transfer ||
      transfer.cancelled ||
      index < 0 ||
      index >= transfer.totalChunks
    )
      return;
    const inflight = transfer.inflight.get(index);
    if (!inflight) return;
    this.clearInflightTimer(inflight);
    transfer.inflight.delete(index);
    transfer.acked.add(index);
    transfer.reason = undefined;
    this.emit(transfer);
    void this.pump(transfer);
  }

  nack(fileId: string, index: number, reason = "Peer rejected chunk"): void {
    const transfer = this.transfers.get(fileId);
    if (
      !transfer ||
      transfer.cancelled ||
      index < 0 ||
      index >= transfer.totalChunks
    )
      return;
    const item = transfer.inflight.get(index);
    if (!item) return;
    this.scheduleRetry(transfer, index, item.attempts + 1, reason);
  }

  pause(fileId: string, reason = "paused"): void {
    const transfer = this.transfers.get(fileId);
    if (
      !transfer ||
      ["completed", "cancelled", "failed"].includes(transfer.status)
    )
      return;
    transfer.paused = true;
    transfer.status = "paused";
    transfer.reason = reason;
    this.holdOutstanding(transfer);
    this.emit(transfer);
  }

  resume(fileId: string): void {
    const transfer = this.transfers.get(fileId);
    if (!transfer || transfer.status !== "paused") return;
    transfer.paused = false;
    transfer.status = transfer.accepted ? "sending" : "offered";
    transfer.reason = transfer.accepted
      ? undefined
      : "Waiting for peer acceptance";
    this.emit(transfer);
    this.resumeOutstanding(transfer);
  }

  async cancel(
    fileId: string,
    reason = "cancelled",
    notify = true,
  ): Promise<void> {
    const transfer = this.transfers.get(fileId);
    if (!transfer) return;
    transfer.cancelled = true;
    transfer.status = "cancelled";
    transfer.reason = reason;
    this.clearTimers(transfer);
    this.emit(transfer);
    if (notify)
      await this.sendApp(
        { kind: "file.cancel", fileId, reason },
        "control",
      ).catch(() => false);
  }

  get activeCount(): number {
    let count = 0;
    for (const transfer of this.transfers.values()) {
      if (!["completed", "cancelled", "failed"].includes(transfer.status))
        count += 1;
    }
    return count;
  }

  private async sendOffer(transfer: Transfer): Promise<void> {
    const ok = await this.sendApp(
      {
        kind: "file.offer",
        fileId: transfer.fileId,
        name: transfer.name,
        mime: transfer.mime,
        size: transfer.size,
        chunkSize: transfer.chunkSize,
        totalChunks: transfer.totalChunks,
        ...(transfer.sha256 ? { sha256: transfer.sha256 } : {}),
      },
      "control",
    );
    if (!ok) this.fail(transfer, "Could not send file offer");
  }

  private async pump(transfer: Transfer): Promise<void> {
    if (transfer.pumping) return;
    transfer.pumping = true;
    try {
      if (
        transfer.cancelled ||
        !transfer.accepted ||
        transfer.paused ||
        this.globalPaused ||
        transfer.status !== "sending"
      )
        return;
      while (
        !transfer.cancelled &&
        !transfer.paused &&
        !this.globalPaused &&
        transfer.inflight.size < this.profile.files.windowChunks &&
        transfer.nextIndex < transfer.totalChunks
      ) {
        const index = transfer.nextIndex++;
        void this.sendChunk(transfer, index, 1);
      }
      await this.completeIfDone(transfer);
    } finally {
      transfer.pumping = false;
    }
  }

  private async sendChunk(
    transfer: Transfer,
    index: number,
    attempts: number,
  ): Promise<void> {
    if (transfer.cancelled || transfer.acked.has(index)) return;
    if (transfer.paused || this.globalPaused) {
      transfer.inflight.set(index, {
        attempts,
        state: "retry_wait",
        timer: null,
      });
      return;
    }
    if (attempts > this.profile.files.maxRetries + 1) {
      await this.failAndNotify(
        transfer,
        `Chunk ${index + 1} failed after retry limit`,
      );
      return;
    }

    const current = transfer.inflight.get(index);
    this.clearInflightTimer(current);
    transfer.inflight.set(index, { attempts, state: "sending", timer: null });
    transfer.reason = attempts > 1 ? `Retrying chunk ${index + 1}` : undefined;
    this.emit(transfer);

    try {
      const start = index * transfer.chunkSize;
      const bytes = new Uint8Array(
        await transfer.file
          .slice(start, Math.min(start + transfer.chunkSize, transfer.size))
          .arrayBuffer(),
      );
      const ok = await this.sendApp(
        {
          kind: "file.chunk",
          fileId: transfer.fileId,
          index,
          totalChunks: transfer.totalChunks,
          data: encodeChunk(bytes),
        },
        "file",
      );
      if (!ok) {
        this.scheduleRetry(
          transfer,
          index,
          attempts + 1,
          "Retrying after browser backpressure",
        );
        return;
      }
      if (transfer.cancelled || transfer.acked.has(index)) return;
      const timer = setTimeout(
        () =>
          this.scheduleRetry(
            transfer,
            index,
            attempts + 1,
            "Retrying after missing ACK",
          ),
        this.profile.files.ackTimeoutMs,
      );
      transfer.inflight.set(index, { attempts, state: "waiting_ack", timer });
      transfer.reason = undefined;
      this.emit(transfer);
    } catch (err) {
      this.scheduleRetry(
        transfer,
        index,
        attempts + 1,
        err instanceof Error ? err.message : "Chunk send failed",
      );
    }
  }

  private scheduleRetry(
    transfer: Transfer,
    index: number,
    nextAttempts: number,
    reason: string,
  ): void {
    if (transfer.cancelled || transfer.acked.has(index)) return;
    const current = transfer.inflight.get(index);
    this.clearInflightTimer(current);
    if (nextAttempts > this.profile.files.maxRetries + 1) {
      void this.failAndNotify(
        transfer,
        `Chunk ${index + 1} failed after retry limit`,
      );
      return;
    }
    const delayMs = Math.min(
      5000,
      400 * 2 ** Math.min(4, Math.max(0, nextAttempts - 2)),
    );
    transfer.reason = reason;
    const timer =
      transfer.paused || this.globalPaused
        ? null
        : setTimeout(
            () => void this.sendChunk(transfer, index, nextAttempts),
            delayMs,
          );
    transfer.inflight.set(index, {
      attempts: nextAttempts - 1,
      state: "retry_wait",
      timer,
    });
    this.emit(transfer);
  }

  private holdOutstanding(transfer: Transfer): void {
    for (const [index, item] of transfer.inflight) {
      this.clearInflightTimer(item);
      transfer.inflight.set(index, {
        attempts: item.attempts,
        state: "retry_wait",
        timer: null,
      });
    }
  }

  private resumeOutstanding(transfer: Transfer): void {
    if (transfer.cancelled || transfer.paused || this.globalPaused) return;
    for (const [index, item] of transfer.inflight) {
      if (item.state === "retry_wait" && item.timer === null)
        void this.sendChunk(transfer, index, item.attempts + 1);
    }
    void this.pump(transfer);
  }

  private async completeIfDone(transfer: Transfer): Promise<void> {
    if (transfer.cancelled) return;
    if (
      transfer.nextIndex < transfer.totalChunks ||
      transfer.inflight.size > 0 ||
      transfer.acked.size < transfer.totalChunks
    )
      return;
    transfer.status = "completed";
    transfer.reason = undefined;
    this.emit(transfer);
    await this.sendApp(
      {
        kind: "file.complete",
        fileId: transfer.fileId,
        ...(transfer.sha256 ? { sha256: transfer.sha256 } : {}),
      },
      "control",
    ).catch(() => false);
  }

  private async failAndNotify(
    transfer: Transfer,
    reason: string,
  ): Promise<void> {
    this.fail(transfer, reason);
    await this.sendApp(
      {
        kind: "file.cancel",
        fileId: transfer.fileId,
        reason: "transfer failed",
      },
      "control",
    ).catch(() => false);
  }

  private fail(transfer: Transfer, reason: string): void {
    transfer.status = "failed";
    transfer.reason = reason;
    transfer.cancelled = true;
    this.clearTimers(transfer);
    this.emit(transfer);
  }

  private clearTimers(transfer: Transfer): void {
    for (const item of transfer.inflight.values())
      this.clearInflightTimer(item);
    transfer.inflight.clear();
  }

  private clearInflightTimer(item: InflightChunk | undefined): void {
    if (item?.timer) clearTimeout(item.timer);
  }

  private emit(transfer: Transfer): void {
    this.onUpdate({
      fileId: transfer.fileId,
      name: transfer.name,
      size: transfer.size,
      sentBytes: Math.min(
        transfer.size,
        transfer.acked.size * transfer.chunkSize,
      ),
      totalBytes: transfer.size,
      progress:
        transfer.totalChunks === 0
          ? 0
          : Math.min(1, transfer.acked.size / transfer.totalChunks),
      status: transfer.status,
      reason: transfer.reason,
    });
  }
}
