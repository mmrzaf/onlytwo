import type { LaneName } from "../config/profiles";
import type { AppMessage, ReliableBodyMessage, ReliableChannelName, ReliableEnvelopeMessage } from "./appMessages";
import { isReliableBody } from "./appMessages";

export interface ReliablePolicy {
  initialRetryMs: number;
  maxRetryMs: number;
  backoffFactor: number;
  maxAttempts: number;
  jitterRatio: number;
  seenTtlMs: number;
}

export interface ReliableSendOptions {
  trackingId?: string;
}

export interface ReliablePendingSnapshot {
  id: string;
  trackingId?: string;
  attempts: number;
  channel: ReliableChannelName;
  createdAt: number;
  lastSentAt: number;
}

export interface ReliableChannelCallbacks {
  send: (message: AppMessage, lane: LaneName) => Promise<boolean>;
  onDelivered?: (reliableId: string, trackingId?: string) => void;
  onFailed?: (reliableId: string, trackingId: string | undefined, reason: string) => void;
  onDuplicate?: (reliableId: string) => void;
}

interface PendingReliable {
  id: string;
  trackingId?: string;
  channel: ReliableChannelName;
  body: ReliableBodyMessage;
  attempts: number;
  createdAt: number;
  lastSentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_POLICY: ReliablePolicy = {
  initialRetryMs: 1500,
  maxRetryMs: 12_000,
  backoffFactor: 2,
  maxAttempts: 5,
  jitterRatio: 0.2,
  seenTtlMs: 10 * 60 * 1000
};

export function isReliableEnvelope(message: AppMessage): message is ReliableEnvelopeMessage {
  return message.kind === "reliable.msg" || message.kind === "reliable.ack" || message.kind === "reliable.nack";
}

export function shouldSendReliably(message: AppMessage, lane: LaneName): message is ReliableBodyMessage {
  if (isReliableEnvelope(message)) return false;
  if (!isReliableBody(message)) return false;
  return lane === "control" || lane === "text";
}

export class ReliableChannel {
  private pending = new Map<string, PendingReliable>();
  private seen = new Map<string, number>();
  private policy: ReliablePolicy;

  constructor(private callbacks: ReliableChannelCallbacks, policy: Partial<ReliablePolicy> = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  async send(body: ReliableBodyMessage, channel: ReliableChannelName, options: ReliableSendOptions = {}): Promise<boolean> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const pending: PendingReliable = {
      id,
      trackingId: options.trackingId,
      channel,
      body,
      attempts: 0,
      createdAt: now,
      lastSentAt: 0,
      timer: null
    };

    this.pending.set(id, pending);
    return this.sendPending(pending);
  }

  async receive(message: ReliableEnvelopeMessage): Promise<ReliableBodyMessage | null> {
    this.sweepSeen();

    switch (message.kind) {
      case "reliable.ack": {
        const pending = this.pending.get(message.id);
        if (!pending) return null;
        this.clearPending(pending);
        this.callbacks.onDelivered?.(message.id, pending.trackingId);
        return null;
      }
      case "reliable.nack": {
        const pending = this.pending.get(message.id);
        if (!pending) return null;
        this.clearPending(pending);
        this.callbacks.onFailed?.(message.id, pending.trackingId, message.reason);
        return null;
      }
      case "reliable.msg": {
        await this.callbacks.send({ kind: "reliable.ack", id: message.id }, "control");

        if (this.seen.has(message.id)) {
          this.callbacks.onDuplicate?.(message.id);
          return null;
        }

        this.seen.set(message.id, Date.now() + this.policy.seenTtlMs);
        return message.body;
      }
    }
  }

  failAll(reason = "Reliable message delivery failed"): void {
    for (const pending of [...this.pending.values()]) {
      this.clearPending(pending);
      this.callbacks.onFailed?.(pending.id, pending.trackingId, reason);
    }
  }

  reset(): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.pending.clear();
    this.seen.clear();
  }

  snapshot(): ReliablePendingSnapshot[] {
    return [...this.pending.values()].map((item) => ({
      id: item.id,
      trackingId: item.trackingId,
      attempts: item.attempts,
      channel: item.channel,
      createdAt: item.createdAt,
      lastSentAt: item.lastSentAt
    }));
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private async sendPending(pending: PendingReliable): Promise<boolean> {
    if (!this.pending.has(pending.id)) return false;

    pending.attempts += 1;
    pending.lastSentAt = Date.now();

    const ok = await this.callbacks.send({
      kind: "reliable.msg",
      id: pending.id,
      channel: pending.channel,
      body: pending.body,
      createdAt: pending.createdAt,
      attempt: pending.attempts
    }, pending.channel);

    if (!ok) {
      this.failPending(pending, "Message could not be queued for transport");
      return false;
    }

    this.armRetry(pending);
    return true;
  }

  private armRetry(pending: PendingReliable): void {
    if (pending.timer) clearTimeout(pending.timer);

    if (pending.attempts >= this.policy.maxAttempts) {
      pending.timer = setTimeout(() => {
        if (this.pending.has(pending.id)) {
          this.failPending(pending, "Message delivery timed out");
        }
      }, this.retryDelayMs(pending.attempts));
      return;
    }

    pending.timer = setTimeout(() => {
      if (this.pending.has(pending.id)) void this.sendPending(pending);
    }, this.retryDelayMs(pending.attempts));
  }

  private retryDelayMs(attempts: number): number {
    const base = Math.min(
      this.policy.initialRetryMs * this.policy.backoffFactor ** Math.max(0, attempts - 1),
      this.policy.maxRetryMs
    );
    const jitter = base * this.policy.jitterRatio;
    return Math.max(1, Math.round(base - jitter + Math.random() * jitter * 2));
  }

  private failPending(pending: PendingReliable, reason: string): void {
    this.clearPending(pending);
    this.callbacks.onFailed?.(pending.id, pending.trackingId, reason);
  }

  private clearPending(pending: PendingReliable): void {
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(pending.id);
  }

  private sweepSeen(): void {
    const now = Date.now();
    for (const [id, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(id);
    }
  }
}
