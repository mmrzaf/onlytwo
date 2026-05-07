import { WsClient } from "../transport/wsClient";
import { MessageType } from "../transport/protocol";
import type { ClientState, ClientPhase } from "../state/clientState";
import { cryptoClient } from "../crypto/keys";

export type SessionCallbacks = {
  onPhaseChange: (phase: ClientPhase) => void;
  onError: () => void;
  onFingerprintAvailable: () => void;
  onMessageDecrypted: (text: string) => void;
  onFileReceived: (fileBlob: Blob, fileName: string) => void;
  onFileProgress?: (received: number, total: number) => void;
  onDecryptionError?: (message: string) => void;
};

const log = (...args: unknown[]) => console.log("[SessionController]", ...args);

export class SessionController {
  private myPublicKey: Uint8Array | null = null;
  private peerPublicKey: Uint8Array | null = null;

  private handshakeIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastRescueAt = 0;

  private readonly BEACON_INTERVAL_MS = 2_000;
  private readonly RESCUE_DEBOUNCE_MS = 3_000;

  private incomingFile: {
    name: string;
    mime: string;
    totalChunks: number;
    chunks: Uint8Array[];
    received: number;
  } | null = null;

  private intentionalEnd = false;

  constructor(
    private ws: WsClient,
    private state: ClientState,
    private callbacks: SessionCallbacks,
  ) {
    this.ws.onStatusChange((status) => {
      switch (status) {
        case "reconnecting":
          if (this.state.phase !== "disconnected" && !this.intentionalEnd) {
            this.setPhase("reconnecting");
          }
          break;

        case "connected":
          if (this.state.phase === "reconnecting" && this.myPublicKey) {
            log("Transport reconnected — restarting handshake");
            this.startHandshakeLoop();
          }
          break;

        case "disconnected":
          if (!this.intentionalEnd && this.state.phase !== "disconnected") {
            this.handleDisconnect(
              "Connection lost after maximum retry attempts.",
            );
          }
          break;
      }
    });

    this.ws.onMessage(async (env) => {
      try {
        switch (env.type) {
          case MessageType.HANDSHAKE:
            await this.handleIncomingHandshake(env.payload);
            break;
          case MessageType.TEXT:
            await this.handleIncomingText(env.payload, env.nonce, env.counter);
            break;
          case MessageType.MEDIA:
            await this.handleIncomingMedia(env.payload, env.nonce, env.counter);
            break;
        }
      } catch (err) {
        console.error("[SessionController] Message handler error:", err);
      }
    });
  }

  async startSession(code: string): Promise<void> {
    this.cleanup();
    this.intentionalEnd = false;
    this.setPhase("connecting");
    this.state.sessionCode = code;
    this.state.lastError = null;

    try {
      await cryptoClient.reset();
      await this.ws.connect(code);
      this.myPublicKey = await cryptoClient.generateIdentity();
      this.state.identityKeyReady = true;
      this.startHandshakeLoop();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to establish connection.";
      this.handleDisconnect(msg);
    }
  }

  async sendMessage(text: string): Promise<void> {
    if (this.state.phase !== "chatting") return;
    try {
      const { ciphertext, nonce, counter } =
        await cryptoClient.encryptMessage(text);
      this.ws.sendChat(ciphertext, nonce, counter);
    } catch (err) {
      console.error("[SessionController] Encryption error:", err);
      this.handleDisconnect("Internal encryption error.");
    }
  }

  async sendFile(file: File): Promise<void> {
    if (this.state.phase !== "chatting") return;

    const CHUNK_SIZE = 64 * 1024; // 64 KiB
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    await this.sendMessage(
      JSON.stringify({
        type: "FILE_META",
        name: file.name,
        size: file.size,
        mime: file.type,
        totalChunks,
      }),
    );

    let offset = 0;
    let sentChunks = 0;

    while (offset < file.size) {
      if (
        this.state.phase !== "chatting" &&
        this.state.phase !== "reconnecting"
      ) {
        break;
      }

      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const chunkBytes = new Uint8Array(await slice.arrayBuffer());

      const { ciphertext, nonce, counter } =
        await cryptoClient.encryptBinary(chunkBytes);

      this.ws.sendMedia(ciphertext, nonce, counter);

      offset += CHUNK_SIZE;
      sentChunks++;

      this.callbacks.onFileProgress?.(sentChunks, totalChunks);

      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  endSession(): void {
    if (this.state.phase === "disconnected") return;
    this.intentionalEnd = true;
    this.setPhase("disconnected");
    this.cleanup();
  }

  private startHandshakeLoop(): void {
    if (!this.myPublicKey) return;
    this.stopHandshakeLoop();
    this.setPhase("handshaking");
    this.ws.sendHandshake(this.myPublicKey);

    this.handshakeIntervalId = setInterval(() => {
      if (this.state.phase === "handshaking" && this.myPublicKey) {
        this.ws.sendHandshake(this.myPublicKey);
      } else {
        this.stopHandshakeLoop();
      }
    }, this.BEACON_INTERVAL_MS);
  }

  private stopHandshakeLoop(): void {
    if (this.handshakeIntervalId !== null) {
      clearInterval(this.handshakeIntervalId);
      this.handshakeIntervalId = null;
    }
  }

  private async handleIncomingHandshake(payload: Uint8Array): Promise<void> {
    if (payload.length === 1 && payload[0] === 0x01) {
      if (this.myPublicKey) this.ws.sendHandshake(this.myPublicKey);
      return;
    }

    if (payload.length !== 32) return;
    if (this.myPublicKey && arraysEqual(payload, this.myPublicKey)) {
      return;
    }

    if (
      this.state.handshakeComplete &&
      this.peerPublicKey &&
      !arraysEqual(payload, this.peerPublicKey)
    ) {
      this.handleDisconnect("Peer restarted their session. Please reconnect.");
      return;
    }

    if (
      this.state.handshakeComplete &&
      this.peerPublicKey &&
      arraysEqual(payload, this.peerPublicKey)
    ) {
      const now = Date.now();
      if (now - this.lastRescueAt > this.RESCUE_DEBOUNCE_MS) {
        this.lastRescueAt = now;
        if (this.myPublicKey) this.ws.sendHandshake(this.myPublicKey);
      }
      if (
        this.state.phase === "handshaking" ||
        this.state.phase === "reconnecting"
      ) {
        this.setPhase("chatting");
      }
      return;
    }

    try {
      this.stopHandshakeLoop();
      this.peerPublicKey = new Uint8Array(payload);

      const { fingerprint } = await cryptoClient.establishSession(payload);

      this.state.handshakeComplete = true;
      this.state.fingerprintPhrase = fingerprint;
      this.lastRescueAt = Date.now();

      if (this.myPublicKey) this.ws.sendHandshake(this.myPublicKey);

      this.setPhase("session_ready");
      this.callbacks.onFingerprintAvailable();

      setTimeout(() => {
        if (this.state.phase === "session_ready") this.setPhase("chatting");
      }, 1_000);
    } catch (err) {
      console.error("[SessionController] Handshake error:", err);
      this.state.handshakeComplete = false;
      this.peerPublicKey = null;
      this.startHandshakeLoop();
    }
  }

  private async handleIncomingText(
    payload: Uint8Array,
    nonce: Uint8Array | undefined,
    counter: bigint | number | undefined,
  ): Promise<void> {
    if (this.state.phase !== "chatting" || !nonce || counter === undefined) {
      return;
    }

    const safeCounter = typeof counter === "bigint" ? counter : BigInt(counter);
    try {
      const text = await cryptoClient.decryptMessage(
        payload,
        nonce,
        safeCounter,
      );

      if (text.startsWith('{"type":"FILE_META"')) {
        try {
          const meta = JSON.parse(text) as {
            name: string;
            mime: string;
            totalChunks: number;
          };
          this.incomingFile = {
            name: meta.name,
            mime: meta.mime,
            totalChunks: meta.totalChunks,
            chunks: [],
            received: 0,
          };
        } catch {
          console.warn("[SessionController] Malformed FILE_META payload");
        }
        return;
      }

      this.callbacks.onMessageDecrypted(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[SessionController] Decrypt error:", msg);
      this.callbacks.onDecryptionError?.(msg);
    }
  }

  private async handleIncomingMedia(
    payload: Uint8Array,
    nonce: Uint8Array | undefined,
    counter: bigint | number | undefined,
  ): Promise<void> {
    if (this.state.phase !== "chatting" || !nonce || counter === undefined) {
      return;
    }
    if (!this.incomingFile) {
      console.warn(
        "[SessionController] MEDIA chunk received without FILE_META",
      );
      return;
    }

    const safeCounter = typeof counter === "bigint" ? counter : BigInt(counter);
    const chunk = await cryptoClient.decryptBinary(payload, nonce, safeCounter);

    const copy = new Uint8Array(chunk.length);
    copy.set(chunk);
    this.incomingFile.chunks.push(copy);
    this.incomingFile.received++;

    this.callbacks.onFileProgress?.(
      this.incomingFile.received,
      this.incomingFile.totalChunks,
    );

    if (this.incomingFile.received === this.incomingFile.totalChunks) {
      const blob = new Blob(
        this.incomingFile.chunks.map((c) => new Uint8Array(c)),
        {
          type: this.incomingFile.mime,
        },
      );
      this.callbacks.onFileReceived(blob, this.incomingFile.name);
      this.incomingFile = null;
    }
  }

  private setPhase(phase: ClientPhase): void {
    if (this.state.phase === phase) return;
    log(`Phase: [${this.state.phase}] → [${phase}]`);
    this.state.phase = phase;
    this.callbacks.onPhaseChange(phase);
  }

  private handleDisconnect(reason: string): void {
    if (this.state.phase === "disconnected") return;
    log("Disconnect:", reason);
    this.state.lastError = reason;
    this.setPhase("disconnected");
    this.cleanup();
    this.callbacks.onError();
  }

  private cleanup(): void {
    this.stopHandshakeLoop();
    this.ws.disconnect();
    cryptoClient.reset().catch(() => {});
    this.myPublicKey = null;
    this.peerPublicKey = null;
    this.lastRescueAt = 0;
    this.incomingFile = null;
    this.state.handshakeComplete = false;
    this.state.fingerprintPhrase = null;
    this.state.identityKeyReady = false;
  }
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
