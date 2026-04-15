import { WsClient } from "../transport/wsClient";
import { MessageType } from "../transport/protocol";
import type { ClientState, ClientPhase } from "../state/clientState";
import { cryptoClient } from "../crypto/keys";

export type SessionCallbacks = {
  onPhaseChange: (phase: ClientPhase) => void;
  onError: () => void;
  onFingerprintAvailable: () => void;
  onMessageDecrypted: (text: string) => void;
};

const log = (...args: any[]) => console.log("[SessionController]", ...args);

const arraysEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

export class SessionController {
  private myPublicKey: Uint8Array | null = null;
  private peerPublicKey: Uint8Array | null = null;

  private handshakeIntervalId: number | null = null;
  private lastRescueAt: number = 0;

  private readonly BEACON_INTERVAL_MS = 2000;
  private readonly RESCUE_DEBOUNCE_MS = 3000;

  constructor(
    private ws: WsClient,
    private state: ClientState,
    private callbacks: SessionCallbacks,
  ) {
    this.ws.onStatusChange((status) => {
      if (
        status === "disconnected" &&
        this.state.phase !== "disconnected" &&
        this.state.phase !== "connecting"
      ) {
        this.handleDisconnect("WebSocket connection abruptly lost.");
      }
    });

    this.ws.onMessage(async (env) => {
      try {
        if (env.type === MessageType.HANDSHAKE) {
          await this.handleIncomingHandshake(env.payload);
        } else if (env.type === MessageType.TEXT) {
          await this.handleIncomingText(env.payload, env.nonce, env.counter);
        }
      } catch (err) {
        console.error(err);
      }
    });
  }

  async startSession(code: string) {
    this.cleanup();
    this.setPhase("connecting");
    this.state.sessionCode = code;
    this.state.lastError = null;

    try {
      await cryptoClient.reset();
      await this.ws.connect(code);

      this.myPublicKey = await cryptoClient.generateIdentity();
      this.state.identityKeyReady = true;

      this.startHandshakeLoop();
    } catch (err: any) {
      this.handleDisconnect(
        err.message || "Failed to establish WebSocket connection.",
      );
    }
  }

  async sendMessage(text: string) {
    if (this.state.phase !== "chatting") {
      return;
    }

    try {
      const { ciphertext, nonce, counter } =
        await cryptoClient.encryptMessage(text);
      this.ws.sendChat(ciphertext, nonce, counter);
    } catch (err) {
      this.handleDisconnect("Internal encryption error.");
    }
  }

  endSession() {
    if (this.state.phase === "disconnected") return;
    this.setPhase("disconnected");
    this.cleanup();
  }

  private startHandshakeLoop() {
    if (!this.myPublicKey) return;

    this.setPhase("handshaking");
    this.ws.sendHandshake(this.myPublicKey);

    this.handshakeIntervalId = window.setInterval(() => {
      if (this.state.phase === "handshaking") {
        this.ws.sendHandshake(this.myPublicKey!);
      } else {
        this.stopHandshakeLoop();
      }
    }, this.BEACON_INTERVAL_MS);
  }

  private stopHandshakeLoop() {
    if (this.handshakeIntervalId !== null) {
      window.clearInterval(this.handshakeIntervalId);
      this.handshakeIntervalId = null;
    }
  }

  private async handleIncomingHandshake(payload: Uint8Array) {
    if (payload.length === 1 && payload[0] === 0x01) {
      if (this.myPublicKey) this.ws.sendHandshake(this.myPublicKey);
      return;
    }

    if (payload.length !== 32) {
      return;
    }

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
      return;
    }

    try {
      this.stopHandshakeLoop();

      this.peerPublicKey = new Uint8Array(payload);

      const { fingerprint } = await cryptoClient.establishSession(payload);
      this.state.handshakeComplete = true;
      this.state.fingerprintPhrase = fingerprint;

      this.lastRescueAt = Date.now();
      this.ws.sendHandshake(this.myPublicKey!);

      this.setPhase("session_ready");
      this.callbacks.onFingerprintAvailable();

      setTimeout(() => {
        if (this.state.phase === "session_ready") {
          this.setPhase("chatting");
        }
      }, 1000);
    } catch (err) {
      this.state.handshakeComplete = false;
      this.peerPublicKey = null;
      this.startHandshakeLoop();
    }
  }

  private async handleIncomingText(
    payload: Uint8Array,
    nonce?: Uint8Array,
    counter?: bigint | number,
  ) {
    if (this.state.phase !== "chatting") {
      return;
    }

    if (!nonce || counter === undefined) {
      return;
    }

    try {
      const safeCounter =
        typeof counter === "bigint" ? counter : BigInt(counter);
      const text = await cryptoClient.decryptMessage(
        payload,
        nonce,
        safeCounter,
      );
      this.callbacks.onMessageDecrypted(text);
    } catch (err) {
      console.error(err);
    }
  }

  private setPhase(phase: ClientPhase) {
    if (this.state.phase === phase) return;
    log(`Phase transition: [${this.state.phase}] -> [${phase}]`);
    this.state.phase = phase;
    this.callbacks.onPhaseChange(phase);
  }

  private handleDisconnect(reason: string) {
    if (this.state.phase === "disconnected") return;

    log("Forced Disconnect:", reason);
    this.state.lastError = reason;

    this.setPhase("disconnected");
    this.cleanup();
    this.callbacks.onError();
  }

  private cleanup() {
    this.stopHandshakeLoop();

    if (this.ws) {
      this.ws.disconnect();
    }

    try {
      cryptoClient.reset();
    } catch (e) {}

    this.myPublicKey = null;
    this.peerPublicKey = null;
    this.lastRescueAt = 0;

    this.state.handshakeComplete = false;
    this.state.fingerprintPhrase = null;
    this.state.identityKeyReady = false;
  }
}
