import {
  packEnvelope,
  unpackEnvelope,
  MessageType,
  createEmptyNonce,
  type MessageEnvelope,
} from "./protocol";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "reconnecting"
  | "connected";

const MAX_RECONNECT_ATTEMPTS = 8;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private code = "";
  private socketEpoch = 0;

  private readonly messageHandlers = new Set<(env: MessageEnvelope) => void>();
  private readonly statusHandlers = new Set<
    (status: ConnectionStatus) => void
  >();

  private outbox: Uint8Array[] = [];
  private isSending = false;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private autoReconnect = false;
  private intentionalClose = false;
  private _status: ConnectionStatus = "disconnected";

  get status(): ConnectionStatus {
    return this._status;
  }

  connect(code: string): Promise<void> {
    this.intentionalClose = false;
    this.autoReconnect = true;
    this.reconnectAttempts = 0;
    this.code = code;
    return this.openSocket();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.autoReconnect = false;
    this.clearReconnectTimer();
    this.closeSocket();
    this.outbox = [];
    this.isSending = false;
    this.notifyStatus("disconnected");
  }

  sendHandshake(publicKey: Uint8Array): void {
    this.enqueue(
      packEnvelope({
        type: MessageType.HANDSHAKE,
        counter: 0n,
        timestamp: BigInt(Date.now()),
        nonce: createEmptyNonce(),
        payload: publicKey,
      }),
    );
  }

  sendChat(ciphertext: Uint8Array, nonce: Uint8Array, counter: bigint): void {
    this.enqueue(
      packEnvelope({
        type: MessageType.TEXT,
        counter,
        timestamp: BigInt(Date.now()),
        nonce,
        payload: ciphertext,
      }),
    );
  }

  sendMedia(ciphertext: Uint8Array, nonce: Uint8Array, counter: bigint): void {
    this.enqueue(
      packEnvelope({
        type: MessageType.MEDIA,
        counter,
        timestamp: BigInt(Date.now()),
        nonce,
        payload: ciphertext,
      }),
    );
  }

  onMessage(cb: (env: MessageEnvelope) => void): () => void {
    this.messageHandlers.add(cb);
    return () => this.messageHandlers.delete(cb);
  }

  onStatusChange(cb: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(cb);
    return () => this.statusHandlers.delete(cb);
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.closeSocket();
      this.notifyStatus("connecting");

      const epoch = ++this.socketEpoch;
      const loc = window.location;
      const proto = loc.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${loc.host}/ws?code=${encodeURIComponent(this.code)}`;

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
        if (this.socketEpoch !== epoch) return;
        opened = true;
        this.reconnectAttempts = 0;
        this.notifyStatus("connected");
        void this.drainOutbox();
        resolve();
      };

      ws.onerror = () => {
        if (!opened && this.socketEpoch === epoch) {
          reject(new Error("WebSocket connection failed"));
        }
      };

      ws.onclose = () => {
        if (this.socketEpoch !== epoch) return;
        if (this.ws === ws) this.ws = null;

        if (!opened) {
        }

        if (this.intentionalClose) {
          this.notifyStatus("disconnected");
          return;
        }

        this.scheduleReconnect();
      };

      ws.onmessage = (ev: MessageEvent) => {
        if (this.socketEpoch !== epoch) return;
        if (!(ev.data instanceof ArrayBuffer)) return;

        try {
          const envelope = unpackEnvelope(ev.data);
          for (const cb of this.messageHandlers) cb(envelope);
        } catch (err) {
          console.warn("[WsClient] Failed to unpack envelope:", err);
        }
      };
    });
  }

  private closeSocket(): void {
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.close();
      } catch {}
    }
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.intentionalClose) return;

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn("[WsClient] Max reconnect attempts reached — giving up");
      this.notifyStatus("disconnected");
      return;
    }

    this.notifyStatus("reconnecting");

    const base = Math.min(
      BASE_DELAY_MS * 2 ** this.reconnectAttempts,
      MAX_DELAY_MS,
    );
    const delay = base + Math.random() * 500;
    this.reconnectAttempts++;

    console.log(
      `[WsClient] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
    );

    this.reconnectTimer = setTimeout(() => {
      if (!this.autoReconnect || this.intentionalClose) return;
      this.openSocket().catch(() => {});
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private enqueue(packet: Uint8Array): void {
    this.outbox.push(packet);
    void this.drainOutbox();
  }

  private async drainOutbox(): Promise<void> {
    if (this.isSending) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.outbox.length === 0) return;

    this.isSending = true;
    try {
      while (this.outbox.length > 0) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;

        const packet = this.outbox[0];
        this.ws.send(new Uint8Array(packet));
        this.outbox.shift();

        if (this.outbox.length > 0) {
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      }
    } catch (err) {
      console.warn("[WsClient] Send error:", err);
    } finally {
      this.isSending = false;
    }
  }

  private notifyStatus(status: ConnectionStatus): void {
    if (this._status === status) return;
    this._status = status;
    for (const cb of this.statusHandlers) cb(status);
  }
}
