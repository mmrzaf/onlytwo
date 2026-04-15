import {
  packEnvelope,
  unpackEnvelope,
  MessageType,
  createEmptyNonce,
  type MessageEnvelope,
} from "./protocol";

export type ConnectionStatus = "disconnected" | "connecting" | "connected";

export class WsClient {
  private ws: WebSocket | null = null;
  private messageHandlers: Set<(env: MessageEnvelope) => void> = new Set();
  private statusChangeHandlers: Set<(status: ConnectionStatus) => void> =
    new Set();

  connect(code: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.disconnect();
      this.notifyStatus("connecting");

      const wsUrl = `ws://localhost:8080/ws?code=${encodeURIComponent(code)}`;
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = "arraybuffer"; // STRICT BINARY ENFORCEMENT

      this.ws.onopen = () => {
        this.notifyStatus("connected");
        resolve();
      };

      this.ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return; // Drop non-binary

        try {
          const envelope = unpackEnvelope(ev.data);
          this.messageHandlers.forEach((cb) => cb(envelope));
        } catch (err) {
          console.error("Failed to unpack binary envelope", err);
        }
      };

      this.ws.onerror = () => reject(new Error("WebSocket connection error"));

      this.ws.onclose = () => {
        this.ws = null;
        this.notifyStatus("disconnected");
      };
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.notifyStatus("disconnected");
  }

  sendHandshake(publicKey: Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const packet = packEnvelope({
      type: MessageType.HANDSHAKE,
      counter: 0n,
      timestamp: BigInt(Date.now()),
      nonce: createEmptyNonce(),
      payload: publicKey, // Raw 32 bytes
    });
    this.ws.send(packet.buffer as ArrayBuffer);
  }

  sendChat(ciphertext: Uint8Array, nonce: Uint8Array, counter: bigint) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const packet = packEnvelope({
      type: MessageType.TEXT,
      counter: counter,
      timestamp: BigInt(Date.now()),
      nonce: nonce,
      payload: ciphertext,
    });
    this.ws.send(packet.buffer as ArrayBuffer);
  }

  onMessage(cb: (env: MessageEnvelope) => void) {
    this.messageHandlers.add(cb);
    return () => this.messageHandlers.delete(cb);
  }

  onStatusChange(cb: (status: ConnectionStatus) => void) {
    this.statusChangeHandlers.add(cb);
    return () => this.statusChangeHandlers.delete(cb);
  }

  private notifyStatus(status: ConnectionStatus) {
    this.statusChangeHandlers.forEach((cb) => cb(status));
  }
}
