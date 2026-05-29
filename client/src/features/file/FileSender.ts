import type { TransportProfile } from "../../config/profiles";
import type { AppMessage } from "../../protocol/appMessages";
import { makeId } from "../../utils/ids";
import { digestBlob, encodeChunk, validateFilename, validateOutboundFile } from "./fileProtocol";

export type SenderStatus = "queued" | "offered" | "sending" | "paused" | "completed" | "cancelled" | "failed";

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

type SendApp = (message: AppMessage, lane: "control" | "file") => Promise<boolean>;
type OnUpdate = (snapshot: SenderSnapshot) => void;

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
  nextIndex: number;
  acked: Set<number>;
  inflight: Map<number, { attempts: number; timer: ReturnType<typeof setTimeout> }>;
  reason?: string;
}

export class FileSender {
  private transfers = new Map<string, Transfer>();
  private globalPaused = false;

  constructor(private profile: TransportProfile, private sendApp: SendApp, private onUpdate: OnUpdate) {}

  setProfile(profile: TransportProfile): void { this.profile = profile; }

  setGlobalPaused(paused: boolean, reason = "paused"): void {
    this.globalPaused = paused;
    for (const transfer of this.transfers.values()) {
      if (transfer.status === "sending" || transfer.status === "paused") {
        transfer.paused = paused;
        transfer.status = paused ? "paused" : "sending";
        transfer.reason = paused ? reason : undefined;
        this.emit(transfer);
        if (!paused) void this.pump(transfer);
      }
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
      nextIndex: 0,
      acked: new Set(),
      inflight: new Map(),
      reason: queued ? "waiting" : undefined
    };
    if (file.size <= this.profile.files.smallBytes) {
      try { transfer.sha256 = await digestBlob(file); } catch { transfer.sha256 = undefined; }
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
    transfer.reason = undefined;
    this.emit(transfer);
    await this.sendOffer(transfer);
  }

  async accept(fileId: string): Promise<void> {
    const transfer = this.transfers.get(fileId);
    if (!transfer || transfer.cancelled) return;
    transfer.accepted = true;
    transfer.status = this.globalPaused ? "paused" : "sending";
    transfer.paused = this.globalPaused;
    transfer.reason = this.globalPaused ? "paused" : undefined;
    this.emit(transfer);
    await this.pump(transfer);
  }

  ack(fileId: string, index: number): void {
    const transfer = this.transfers.get(fileId);
    if (!transfer) return;
    const item = transfer.inflight.get(index);
    if (item) clearTimeout(item.timer);
    transfer.inflight.delete(index);
    transfer.acked.add(index);
    this.emit(transfer);
    void this.pump(transfer);
  }

  nack(fileId: string, index: number): void {
    const transfer = this.transfers.get(fileId);
    if (!transfer || transfer.cancelled) return;
    const item = transfer.inflight.get(index);
    if (item) clearTimeout(item.timer);
    transfer.inflight.delete(index);
    void this.sendChunk(transfer, index, 0);
  }

  pause(fileId: string, reason = "paused"): void {
    const transfer = this.transfers.get(fileId);
    if (!transfer || transfer.status === "completed" || transfer.status === "cancelled") return;
    transfer.paused = true;
    transfer.status = "paused";
    transfer.reason = reason;
    this.emit(transfer);
  }

  resume(fileId: string): void {
    const transfer = this.transfers.get(fileId);
    if (!transfer || transfer.status !== "paused") return;
    transfer.paused = false;
    transfer.status = transfer.accepted ? "sending" : "offered";
    transfer.reason = undefined;
    this.emit(transfer);
    void this.pump(transfer);
  }

  async cancel(fileId: string, reason = "cancelled", notify = true): Promise<void> {
    const transfer = this.transfers.get(fileId);
    if (!transfer) return;
    transfer.cancelled = true;
    transfer.status = "cancelled";
    transfer.reason = reason;
    for (const item of transfer.inflight.values()) clearTimeout(item.timer);
    transfer.inflight.clear();
    this.emit(transfer);
    if (notify) await this.sendApp({ kind: "file.cancel", fileId, reason }, "control").catch(() => false);
  }

  get activeCount(): number {
    let count = 0;
    for (const t of this.transfers.values()) if (!["completed", "cancelled", "failed"].includes(t.status)) count += 1;
    return count;
  }

  private async sendOffer(transfer: Transfer): Promise<void> {
    const ok = await this.sendApp({ kind: "file.offer", fileId: transfer.fileId, name: transfer.name, mime: transfer.mime, size: transfer.size, chunkSize: transfer.chunkSize, totalChunks: transfer.totalChunks, ...(transfer.sha256 ? { sha256: transfer.sha256 } : {}) }, "control");
    if (!ok) this.fail(transfer, "Could not send file offer");
  }

  private async pump(transfer: Transfer): Promise<void> {
    if (transfer.cancelled || !transfer.accepted || transfer.paused || this.globalPaused) return;
    if (transfer.status !== "sending") return;
    while (!transfer.cancelled && !transfer.paused && !this.globalPaused && transfer.inflight.size < this.profile.files.windowChunks && transfer.nextIndex < transfer.totalChunks) {
      const index = transfer.nextIndex++;
      await this.sendChunk(transfer, index, 0);
    }
    if (transfer.nextIndex >= transfer.totalChunks && transfer.inflight.size === 0 && transfer.acked.size >= transfer.totalChunks) {
      transfer.status = "completed";
      transfer.reason = undefined;
      this.emit(transfer);
      await this.sendApp({ kind: "file.complete", fileId: transfer.fileId, ...(transfer.sha256 ? { sha256: transfer.sha256 } : {}) }, "control").catch(() => false);
    }
  }

  private async sendChunk(transfer: Transfer, index: number, attempts: number): Promise<void> {
    if (transfer.cancelled || transfer.paused || this.globalPaused || transfer.acked.has(index)) return;
    if (attempts > this.profile.files.maxRetries) {
      this.fail(transfer, `Chunk ${index + 1} failed`);
      await this.sendApp({ kind: "file.cancel", fileId: transfer.fileId, reason: "transfer failed" }, "control").catch(() => false);
      return;
    }
    const start = index * transfer.chunkSize;
    const bytes = new Uint8Array(await transfer.file.slice(start, Math.min(start + transfer.chunkSize, transfer.size)).arrayBuffer());
    const ok = await this.sendApp({ kind: "file.chunk", fileId: transfer.fileId, index, totalChunks: transfer.totalChunks, data: encodeChunk(bytes) }, "file");
    if (!ok) {
      setTimeout(() => void this.sendChunk(transfer, index, attempts + 1), 600);
      return;
    }
    const timer = setTimeout(() => {
      transfer.inflight.delete(index);
      void this.sendChunk(transfer, index, attempts + 1);
    }, this.profile.files.ackTimeoutMs);
    transfer.inflight.set(index, { attempts, timer });
    this.emit(transfer);
  }

  private fail(transfer: Transfer, reason: string): void {
    transfer.status = "failed";
    transfer.reason = reason;
    transfer.cancelled = true;
    for (const item of transfer.inflight.values()) clearTimeout(item.timer);
    transfer.inflight.clear();
    this.emit(transfer);
  }

  private emit(transfer: Transfer): void {
    this.onUpdate({ fileId: transfer.fileId, name: transfer.name, size: transfer.size, sentBytes: Math.min(transfer.size, transfer.acked.size * transfer.chunkSize), totalBytes: transfer.size, progress: transfer.totalChunks === 0 ? 0 : Math.min(1, transfer.acked.size / transfer.totalChunks), status: transfer.status, reason: transfer.reason });
  }
}
