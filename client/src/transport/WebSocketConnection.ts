import type { TransportProfile } from "../config/profiles";
import { packEnvelope, unpackEnvelope, type Envelope } from "../protocol/envelope";
import { bufferFromBytes } from "../utils/bytes";
import { createTransportMetrics, type TransportMetrics } from "./metrics";
import { PacketScheduler } from "./PacketScheduler";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "failed";

export class WebSocketConnection {
  private ws: WebSocket | null = null;
  private scheduler: PacketScheduler;
  private statusValue: ConnectionStatus = "disconnected";
  private metricsValue: TransportMetrics = createTransportMetrics();
  private code = "";
  private epoch = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private draining = false;
  private statusHandlers = new Set<(status: ConnectionStatus) => void>();
  private envelopeHandlers = new Set<(env: Envelope) => void>();
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
      laneBytes: { ...this.metricsValue.laneBytes }
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
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    await this.open(false);
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.clearDrainTimer();
    this.scheduler.clear();
    this.closeSocket();
    this.setStatus("disconnected");
    this.updateQueueMetrics();
  }

  send(env: Envelope): boolean {
    let bytes: Uint8Array;

    try {
      bytes = packEnvelope(env, this.profile);
    } catch (err) {
      this.setError(err);
      return false;
    }

    const result = this.scheduler.enqueue({ lane: env.lane, bytes });

    if (result.dropped > 0 && env.lane === "voice") {
      this.metricsValue.droppedVoiceFrames += result.dropped;
    }

    if (!result.ok) {
      this.metricsValue.lastError = result.reason ?? "enqueue_failed";
      this.emitMetrics();
      return false;
    }

    this.updateQueueMetrics();
    void this.drain();
    return true;
  }

  onStatus(cb: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(cb);
    return () => this.statusHandlers.delete(cb);
  }

  onEnvelope(cb: (env: Envelope) => void): () => void {
    this.envelopeHandlers.add(cb);
    return () => this.envelopeHandlers.delete(cb);
  }

  onMetrics(cb: (metrics: TransportMetrics) => void): () => void {
    this.metricsHandlers.add(cb);
    return () => this.metricsHandlers.delete(cb);
  }

  private async open(reconnecting: boolean): Promise<void> {
    this.closeSocket();
    this.setStatus(reconnecting ? "reconnecting" : "connecting");

    const currentEpoch = ++this.epoch;
    const loc = window.location;
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${loc.host}/ws?code=${encodeURIComponent(this.code)}`;

    await new Promise<void>((resolve, reject) => {
      let ws: WebSocket;

      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws = ws;
      ws.binaryType = "arraybuffer";

      let opened = false;

      ws.onopen = () => {
        if (this.epoch !== currentEpoch) return;
        opened = true;
        this.reconnectAttempts = 0;
        this.setStatus("connected");
        void this.drain();
        resolve();
      };

      ws.onerror = () => {
        if (!opened && this.epoch === currentEpoch) {
          reject(new Error("WebSocket connection failed"));
        }
      };

      ws.onclose = () => {
        if (this.epoch !== currentEpoch) return;
        if (this.ws === ws) this.ws = null;

        if (this.intentionalClose) {
          this.setStatus("disconnected");
          return;
        }

        this.scheduler.clearVolatile();
        this.updateQueueMetrics();
        this.scheduleReconnect();
      };

      ws.onmessage = (event: MessageEvent) => {
        if (this.epoch !== currentEpoch || !(event.data instanceof ArrayBuffer)) return;

        try {
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
      this.profile.reconnect.maxDelayMs
    );
    const delay = base + Math.random() * this.profile.reconnect.jitterMs;

    this.reconnectAttempts += 1;
    this.metricsValue.reconnects += 1;
    this.setStatus("reconnecting");
    this.emitMetrics();

    this.reconnectTimer = setTimeout(() => {
      if (!this.intentionalClose) {
        this.open(true).catch(() => this.scheduleReconnect());
      }
    }, delay);
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.clearDrainTimer();
    this.draining = true;

    try {
      for (;;) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;

        if (this.ws.bufferedAmount > this.profile.outbox.maxBufferedAmountBytes) {
          this.metricsValue.backpressurePauses += 1;
          this.metricsValue.lastError = "browser_backpressure";
          this.scheduleDrain(25);
          break;
        }

        const packet = this.scheduler.next();
        if (!packet) break;

        this.ws.send(bufferFromBytes(packet.bytes));
        this.metricsValue.sentPackets += 1;
        this.metricsValue.sentBytes += packet.bytes.byteLength;
        this.updateQueueMetrics();

        if (this.ws.bufferedAmount > this.profile.outbox.resumeBufferedAmountBytes) {
          this.scheduleDrain(25);
          break;
        }

        await new Promise<void>((resolve) => setTimeout(resolve, this.profile.outbox.drainYieldMs));
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
    } catch {
      // ignore close errors
    }
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

  private updateQueueMetrics(): void {
    const s = this.scheduler.snapshot();
    this.metricsValue.queuedPackets = s.packets;
    this.metricsValue.queuedBytes = s.bytes;
    this.metricsValue.lanePackets = s.lanePackets;
    this.metricsValue.laneBytes = s.laneBytes;
    this.emitMetrics();
  }

  private setError(err: unknown): void {
    this.metricsValue.lastError = err instanceof Error ? err.message : String(err);
    this.emitMetrics();
  }

  private emitMetrics(): void {
    const metrics = this.metrics;
    for (const cb of this.metricsHandlers) cb(metrics);
  }
}
