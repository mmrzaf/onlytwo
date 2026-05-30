import type { TransportProfile } from "../config/profiles";
import {
  packEnvelope,
  unpackEnvelope,
  type Envelope,
} from "../protocol/envelope";
import {
  decodeRelayEvent,
  encodeSessionEndCommand,
  type RelayEvent,
} from "../protocol/relayControl";
import { bufferFromBytes } from "../utils/bytes";
import {
  createTransportMetrics,
  type TransportMetrics,
  type VoiceDropMetric,
} from "./metrics";
import { PacketScheduler } from "./PacketScheduler";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

const VOICE_BROWSER_BUFFER_LIMIT_BYTES = 64 * 1024;
const SLOT_STORAGE_PREFIX = "onlytwo.slot.";
const SLOT_PROTOCOL_PREFIX = "onlytwo-slot.";

export class WebSocketConnection {
  private ws: WebSocket | null = null;
  private scheduler: PacketScheduler;
  private statusValue: ConnectionStatus = "disconnected";
  private metricsValue: TransportMetrics = createTransportMetrics();
  private code = "";
  private slotToken = "";
  private epoch = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private draining = false;
  private statusHandlers = new Set<(status: ConnectionStatus) => void>();
  private envelopeHandlers = new Set<(env: Envelope) => void>();
  private relayHandlers = new Set<(event: RelayEvent) => void>();
  private metricsHandlers = new Set<(metrics: TransportMetrics) => void>();

  constructor(private profile: TransportProfile) {
    this.scheduler = new PacketScheduler(profile);
  }

  get status(): ConnectionStatus {
    return this.statusValue;
  }

  get metrics(): TransportMetrics {
    return {
      ...this.metricsValue,
      lanePackets: { ...this.metricsValue.lanePackets },
      laneBytes: { ...this.metricsValue.laneBytes },
    };
  }

  setProfile(profile: TransportProfile): void {
    this.profile = profile;
    this.scheduler.setProfile(profile);
    this.updateQueueMetrics();
    void this.drain();
  }

  async connect(code: string): Promise<void> {
    this.code = code;
    this.slotToken = getOrCreateSlotToken(code);
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    await this.open(false);
  }

  clearQueuedPackets(): void {
    this.clearDrainTimer();
    this.scheduler.clear();
    this.updateQueueMetrics();
  }

  disconnect(options: { forgetSlot?: boolean } = {}): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.clearQueuedPackets();
    this.closeSocket();
    if (options.forgetSlot) this.forgetSlotToken();
    this.setStatus("disconnected");
    this.updateQueueMetrics();
  }

  endSession(): boolean {
    const ws = this.ws;
    this.forgetSlotToken();
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(bufferFromBytes(encodeSessionEndCommand()));
      return true;
    } catch (err) {
      this.setError(err);
      return false;
    }
  }

  canSendVoiceNow(): boolean {
    return (
      !!this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.ws.bufferedAmount <= VOICE_BROWSER_BUFFER_LIMIT_BYTES
    );
  }

  send(env: Envelope): boolean {
    if (env.lane === "voice") {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.metricsValue.lastError = "voice_transport_unavailable";
        this.recordVoiceDrop("browser_backpressure");
        return false;
      }
      if (this.ws.bufferedAmount > VOICE_BROWSER_BUFFER_LIMIT_BYTES) {
        this.metricsValue.lastError = "voice_browser_backpressure";
        this.recordVoiceDrop("browser_backpressure");
        return false;
      }
    }

    let bytes: Uint8Array;
    try {
      bytes = packEnvelope(env, this.profile);
    } catch (err) {
      this.setError(err);
      return false;
    }

    const result = this.scheduler.enqueue({ lane: env.lane, bytes });
    if (result.dropped > 0 && env.lane === "voice")
      this.metricsValue.droppedVoiceFrames += result.dropped;
    if (!result.ok) {
      this.metricsValue.lastError = result.reason ?? "enqueue_failed";
      this.emitMetrics();
      return false;
    }

    this.updateQueueMetrics();
    void this.drain();
    return true;
  }

  recordVoiceDrop(reason: VoiceDropMetric, count = 1): void {
    if (count <= 0) return;
    this.metricsValue.droppedVoiceFrames += count;
    switch (reason) {
      case "before_encrypt":
        this.metricsValue.voiceDroppedBeforeEncrypt += count;
        break;
      case "before_decrypt":
        this.metricsValue.voiceDroppedBeforeDecrypt += count;
        break;
      case "browser_backpressure":
        this.metricsValue.voiceDroppedBrowserBackpressure += count;
        break;
      case "playback_stale":
        this.metricsValue.voiceDroppedPlaybackStale += count;
        break;
      case "playback_lead_reset":
        this.metricsValue.voicePlaybackLeadResets += count;
        break;
    }
    this.emitMetrics();
  }

  recordVoiceQueueSize(size: number): void {
    if (size <= this.metricsValue.voiceQueuePeakFrames) return;
    this.metricsValue.voiceQueuePeakFrames = size;
    this.emitMetrics();
  }

  onStatus(cb: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(cb);
    return () => this.statusHandlers.delete(cb);
  }

  onEnvelope(cb: (env: Envelope) => void): () => void {
    this.envelopeHandlers.add(cb);
    return () => this.envelopeHandlers.delete(cb);
  }

  onRelayEvent(cb: (event: RelayEvent) => void): () => void {
    this.relayHandlers.add(cb);
    return () => this.relayHandlers.delete(cb);
  }

  onMetrics(cb: (metrics: TransportMetrics) => void): () => void {
    this.metricsHandlers.add(cb);
    return () => this.metricsHandlers.delete(cb);
  }

  private async open(reconnecting: boolean): Promise<void> {
    const currentEpoch = ++this.epoch;
    this.closeSocket();
    this.setStatus(reconnecting ? "reconnecting" : "connecting");
    const loc = window.location;
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${loc.host}/ws?code=${encodeURIComponent(this.code)}`;
    const protocol = `${SLOT_PROTOCOL_PREFIX}${this.slotToken}`;

    await new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, [protocol]);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws = ws;
      ws.binaryType = "arraybuffer";
      let opened = false;
      let settled = false;
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rejectOnce = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      ws.onopen = () => {
        if (this.epoch !== currentEpoch) return;
        opened = true;
        this.reconnectAttempts = 0;
        this.setStatus("connected");
        void this.drain();
        resolveOnce();
      };

      ws.onerror = () => {
        if (!opened && this.epoch === currentEpoch)
          rejectOnce(new Error("WebSocket connection failed"));
      };

      ws.onclose = (event) => {
        if (this.epoch !== currentEpoch) return;
        if (this.ws === ws) this.ws = null;
        if (!opened) {
          rejectOnce(
            new Error(
              event.reason || "WebSocket connection closed before opening",
            ),
          );
          return;
        }

        if (event.code === 4000 || event.reason === "session ended") {
          this.intentionalClose = true;
          this.clearQueuedPackets();
          this.emitRelay({ kind: "session.ended" });
          this.setStatus("disconnected");
          return;
        }

        if (this.intentionalClose) {
          this.setStatus("disconnected");
          return;
        }

        this.clearQueuedPackets();
        this.scheduleReconnect();
      };

      ws.onmessage = (event: MessageEvent) => {
        if (this.epoch !== currentEpoch || !(event.data instanceof ArrayBuffer))
          return;
        try {
          const relayEvent = decodeRelayEvent(event.data);
          if (relayEvent) {
            if (relayEvent.kind === "session.ended")
              this.intentionalClose = true;
            this.emitRelay(relayEvent);
            return;
          }
          const env = unpackEnvelope(event.data, this.profile);
          for (const cb of this.envelopeHandlers) cb(env);
        } catch (err) {
          this.setError(err);
        }
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    if (this.reconnectAttempts >= this.profile.reconnect.maxAttempts) {
      this.setStatus("failed");
      this.metricsValue.lastError = "reconnect_exhausted";
      this.emitMetrics();
      return;
    }

    const base = Math.min(
      this.profile.reconnect.baseDelayMs * 2 ** this.reconnectAttempts,
      this.profile.reconnect.maxDelayMs,
    );
    const delay = base + Math.random() * this.profile.reconnect.jitterMs;
    this.reconnectAttempts += 1;
    this.metricsValue.reconnects += 1;
    this.setStatus("reconnecting");
    this.emitMetrics();

    this.reconnectTimer = setTimeout(() => {
      if (!this.intentionalClose)
        this.open(true).catch(() => this.scheduleReconnect());
    }, delay);
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.ws || this.ws.readyState !== WebSocket.OPEN)
      return;
    this.clearDrainTimer();
    this.draining = true;

    try {
      for (;;) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;
        if (
          this.ws.bufferedAmount > this.profile.outbox.maxBufferedAmountBytes
        ) {
          this.metricsValue.backpressurePauses += 1;
          this.metricsValue.lastError = "browser_backpressure";
          this.scheduleDrain(25);
          break;
        }

        const packet = this.scheduler.next();
        if (!packet) break;
        if (
          packet.lane === "voice" &&
          this.ws.bufferedAmount > VOICE_BROWSER_BUFFER_LIMIT_BYTES
        ) {
          this.recordVoiceDrop("browser_backpressure");
          this.updateQueueMetrics();
          continue;
        }

        this.ws.send(bufferFromBytes(packet.bytes));
        this.metricsValue.sentPackets += 1;
        this.metricsValue.sentBytes += packet.bytes.byteLength;
        this.updateQueueMetrics();

        if (
          this.ws.bufferedAmount > this.profile.outbox.resumeBufferedAmountBytes
        ) {
          this.scheduleDrain(25);
          break;
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, this.profile.outbox.drainYieldMs),
        );
      }
    } finally {
      this.draining = false;
      this.emitMetrics();
    }
  }

  private scheduleDrain(delayMs: number): void {
    if (this.drainTimer !== null) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      void this.drain();
    }, delayMs);
  }

  private closeSocket(): void {
    if (!this.ws) return;
    const old = this.ws;
    this.ws = null;
    try {
      old.close();
    } catch {}
  }

  private forgetSlotToken(): void {
    if (!this.code) return;
    try {
      sessionStorage.removeItem(`${SLOT_STORAGE_PREFIX}${this.code}`);
    } catch {}
    this.slotToken = "";
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearDrainTimer(): void {
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    for (const cb of this.statusHandlers) cb(status);
  }

  private emitRelay(event: RelayEvent): void {
    for (const cb of this.relayHandlers) cb(event);
  }

  private updateQueueMetrics(): void {
    const snapshot = this.scheduler.snapshot();
    this.metricsValue.queuedPackets = snapshot.packets;
    this.metricsValue.queuedBytes = snapshot.bytes;
    this.metricsValue.lanePackets = snapshot.lanePackets;
    this.metricsValue.laneBytes = snapshot.laneBytes;
    this.emitMetrics();
  }

  private setError(err: unknown): void {
    this.metricsValue.lastError =
      err instanceof Error ? err.message : String(err);
    this.emitMetrics();
  }

  private emitMetrics(): void {
    const metrics = this.metrics;
    for (const cb of this.metricsHandlers) cb(metrics);
  }
}

function getOrCreateSlotToken(code: string): string {
  const key = `${SLOT_STORAGE_PREFIX}${code}`;
  try {
    const existing = sessionStorage.getItem(key);
    if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
    const token = crypto.randomUUID().replace(/-/g, "");
    sessionStorage.setItem(key, token);
    return token;
  } catch {
    return crypto.randomUUID().replace(/-/g, "");
  }
}
