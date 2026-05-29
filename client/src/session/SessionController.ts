import {
  getProfile,
  supportedProfileIds,
  type LaneName,
  type TransportProfile,
  type TransportProfileId,
} from "../config/profiles";
import { CryptoClient } from "../crypto/CryptoClient";
import { SecureChannel } from "../crypto/SecureChannel";
import {
  FileReceiver,
  type ReceiverSnapshot,
} from "../features/file/FileReceiver";
import { FileSender, type SenderSnapshot } from "../features/file/FileSender";
import { createTextMessage } from "../features/text/TextService";
import { VoiceService, type VoiceFrame } from "../features/audio/VoiceService";
import {
  APP_VERSION,
  decodeHandshake,
  encodeHandshake,
  FEATURE_FLAGS,
  type AppMessage,
  type HandshakeMessage,
} from "../protocol/appMessages";
import { OuterType, type Envelope } from "../protocol/envelope";
import {
  negotiateProfile,
  profileHash,
  verificationPhrase,
} from "../protocol/negotiation";
import {
  ReliableChannel,
  isReliableEnvelope,
  shouldSendReliably,
} from "../protocol/reliable";
import {
  WebSocketConnection,
  type ConnectionStatus,
} from "../transport/WebSocketConnection";
import { base64UrlToBytes, bytesToBase64Url } from "../utils/bytes";
import { generateRoomCode, makeId, normalizeRoomCode } from "../utils/ids";
import type { SessionViewState, StateListener, TransferView } from "./types";

const MAX_SYSTEM_ITEMS = 5;

export class SessionController {
  private profile: TransportProfile = getProfile("balanced");
  private crypto = new CryptoClient();
  private secure: SecureChannel | null = null;
  private transport = new WebSocketConnection(this.profile);
  private voice = new VoiceService(this.profile);

  private sender = new FileSender(
    this.profile,
    (message, lane) => this.sendApp(message, lane),
    (snapshot) => this.updateSender(snapshot),
  );

  private receiver = new FileReceiver(
    this.profile,
    (message, lane) => this.sendApp(message, lane),
    (snapshot) => this.updateReceiver(snapshot),
    () => undefined,
  );

  private listeners = new Set<StateListener>();

  private localPublicKey: Uint8Array | null = null;
  private peerPublicKey: Uint8Array | null = null;

  private initialHandshakeSent = false;
  private replyHandshakeSent = false;
  private establishing = false;

  private cryptoSerial: Promise<unknown> = Promise.resolve();
  private transferOrder: string[] = [];
  private reliable = new ReliableChannel({
    send: (message, lane) => this.sendRawApp(message, lane),
    onDelivered: (_reliableId, trackingId) => {
      if (trackingId) this.updateTranscriptStatus(trackingId, "sent");
    },
    onFailed: (_reliableId, trackingId, reason) => {
      if (trackingId) this.updateTranscriptStatus(trackingId, "failed");
      this.patch({ notice: reason });
    },
  });

  private state: SessionViewState = {
    phase: "idle",
    roomCode: "",
    profileId: "balanced",
    connection: "disconnected",
    security: "none",
    safetyPhrase: null,
    notice: null,
    voice: "idle",
    muted: false,
    invalidPackets: 0,
    transcript: [],
    transfers: [],
  };

  constructor() {
    this.transport.onStatus((status) => this.onConnectionStatus(status));
    this.transport.onEnvelope((env) => void this.onEnvelope(env));
    window.addEventListener("beforeunload", () => this.disconnect(true));
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  setProfile(id: TransportProfileId): void {
    if (this.state.phase !== "idle") return;

    this.profile = getProfile(id);
    this.transport.setProfile(this.profile);
    this.voice.setProfile(this.profile);
    this.sender.setProfile(this.profile);
    this.receiver.setProfile(this.profile);

    this.patch({ profileId: id });
  }

  async createRoom(): Promise<void> {
    await this.start(generateRoomCode(), "creating");
  }

  async joinRoom(rawCode: string): Promise<void> {
    const code = normalizeRoomCode(rawCode);
    if (code.length < 9) throw new Error("Enter the full room code");
    await this.start(code, "joining");
  }

  async sendText(body: string): Promise<void> {
    const text = body.trim();
    if (!text) return;

    if (!this.secure) {
      this.patch({
        security: "none",
        notice: "Encryption is not ready. Leave and rejoin this room.",
      });
      return;
    }

    const message = createTextMessage(text);

    this.addTranscript({
      id: message.messageId,
      kind: "text",
      from: "me",
      text: message.body,
      at: message.createdAt,
      status: "sending",
    });

    const ok = await this.sendApp(message, "text", message.messageId);

    if (!ok) {
      this.updateTranscriptStatus(message.messageId, "failed");
    }
  }

  async offerFile(file: File): Promise<void> {
    if (!this.secure) {
      this.patch({ notice: "Encryption is not ready." });
      return;
    }

    const voiceActive = this.isVoiceActive();
    const queued = voiceActive || this.hasActiveFile();

    const fileId = await this.sender.offer(file, queued);
    this.ensureTransferOrder(fileId);

    if (queued) {
      this.addSystem(
        voiceActive ? "File queued until voice ends." : "File queued.",
      );
    }
  }

  async acceptFile(fileId: string): Promise<void> {
    await this.receiver.accept(fileId);
  }

  async rejectFile(fileId: string): Promise<void> {
    await this.receiver.reject(fileId);
  }

  async cancelFile(fileId: string): Promise<void> {
    const transfer = this.state.transfers.find(
      (item) => item.fileId === fileId,
    );
    if (!transfer) return;

    if (transfer.direction === "send") {
      await this.sender.cancel(fileId, "cancelled");
    } else {
      await this.receiver.cancel(fileId, "cancelled");
    }

    this.startNextQueuedFileIfAllowed();
  }

  async startVoice(): Promise<void> {
    if (!this.secure) {
      this.patch({ notice: "Encryption is not ready." });
      return;
    }

    if (this.state.voice !== "idle") return;

    this.sender.setGlobalPaused(true, "paused during voice");
    this.patch({ voice: "starting", notice: "Starting voice…" });

    try {
      await this.voice.start((frame) => void this.sendVoiceFrame(frame));

      this.patch({
        voice: "active",
        muted: false,
        notice: "Voice active. Files are paused.",
      });

      await this.sendApp(
        {
          kind: "voice.start",
          streamId: "voice",
          sampleRate: this.voice.actualSampleRate,
          frameMs: this.profile.voice.frameMs,
          mode: this.profile.voice.mode,
        },
        "control",
      );
    } catch (err) {
      this.voice.stop();
      this.sender.setGlobalPaused(false);

      this.patch({
        voice: "failed",
        notice: err instanceof Error ? err.message : "Voice failed",
      });

      setTimeout(() => {
        if (this.state.voice === "failed") {
          this.patch({ voice: "idle" });
        }
      }, 2500);
    }
  }

  async stopVoice(): Promise<void> {
    if (this.state.voice === "idle") return;

    this.voice.stop();
    await this.sendApp({ kind: "voice.stop", streamId: "voice" }, "control");

    this.patch({
      voice: "idle",
      muted: false,
      notice: "Voice ended.",
    });

    this.sender.setGlobalPaused(false);
    this.startNextQueuedFileIfAllowed();
  }

  toggleMute(): void {
    if (this.state.voice !== "active" && this.state.voice !== "muted") return;

    const muted = !this.state.muted;
    this.voice.setMuted(muted);

    this.patch({
      muted,
      voice: muted ? "muted" : "active",
    });
  }

  async markVerified(matches: boolean): Promise<void> {
    if (!this.secure) {
      this.patch({
        security: "none",
        notice: "Encryption is not ready. Leave and rejoin this room.",
      });
      return;
    }

    if (!matches) {
      this.patch({
        security: "verification_failed",
        notice: "Verification mismatch. Leave this room.",
      });
      return;
    }

    this.patch({
      security: "verified",
      notice: "Verified on this device.",
    });

    await this.sendApp({ kind: "session.verified", at: Date.now() }, "control");
  }

  disconnect(silent = false): void {
    this.establishing = false;
    this.initialHandshakeSent = false;
    this.replyHandshakeSent = false;

    this.voice.stop();
    this.sender.setGlobalPaused(true, "disconnected");
    this.transport.disconnect();

    void this.crypto.reset().catch(() => undefined);

    this.secure = null;
    this.localPublicKey = null;
    this.peerPublicKey = null;
    this.cryptoSerial = Promise.resolve();
    this.transferOrder = [];
    this.reliable.reset();

    if (!silent) {
      this.patch({
        phase: "ended",
        connection: "disconnected",
        security: "none",
        safetyPhrase: null,
        voice: "idle",
        muted: false,
        notice: "Room closed.",
      });
    }
  }

  private async start(
    code: string,
    phase: "creating" | "joining",
  ): Promise<void> {
    this.disconnect(true);

    this.profile = getProfile(this.state.profileId);
    this.transport.setProfile(this.profile);
    this.voice.setProfile(this.profile);
    this.sender.setProfile(this.profile);
    this.receiver.setProfile(this.profile);

    this.transferOrder = [];
    this.reliable.reset();
    this.initialHandshakeSent = false;
    this.replyHandshakeSent = false;
    this.establishing = false;

    this.patch({
      phase,
      roomCode: code,
      connection: "connecting",
      security: "none",
      safetyPhrase: null,
      notice:
        phase === "creating"
          ? "Room created. Share the code."
          : "Joining room…",
      transcript: [],
      transfers: [],
      invalidPackets: 0,
      voice: "idle",
      muted: false,
    });

    await this.crypto.configure(this.profile);
    this.localPublicKey = await this.crypto.generateIdentity();
    await this.transport.connect(code);

    this.patch({
      phase: "waiting",
      notice: "Waiting for the other person.",
    });

    await this.sendInitialHandshake();
  }

  private onConnectionStatus(status: ConnectionStatus): void {
    this.patch({ connection: status });

    if (
      status === "connected" &&
      this.localPublicKey &&
      !this.secure &&
      !this.initialHandshakeSent
    ) {
      void this.sendInitialHandshake();
    }

    if (status === "reconnecting") {
      this.sender.setGlobalPaused(true, "reconnecting");
      this.patch({ notice: "Reconnecting…" });
    }

    if (status === "connected" && !this.isVoiceActive()) {
      this.sender.setGlobalPaused(false);
      this.startNextQueuedFileIfAllowed();
    }

    if (status === "failed") {
      this.patch({
        phase: "failed",
        notice: "Connection lost.",
      });
    }
  }

  private async onEnvelope(env: Envelope): Promise<void> {
    try {
      if (env.outerType === OuterType.HANDSHAKE) {
        await this.handleHandshake(env.payload);
        return;
      }

      if (!this.secure) return;

      const message = await this.runCrypto(() =>
        this.secure!.decryptAppMessage(env),
      );
      await this.handleAppMessage(message);
    } catch (err) {
      this.state.invalidPackets += 1;

      if (
        this.state.invalidPackets === 3 ||
        this.state.invalidPackets % 20 === 0
      ) {
        this.patch({ notice: "Network unstable. Some packets were dropped." });
      } else {
        this.emit();
      }

      console.warn("OnlyTwo packet dropped", err);
    }
  }

  private async handleHandshake(payload: Uint8Array): Promise<void> {
    if (!this.localPublicKey) return;

    const hs = decodeHandshake(payload);
    const peerKey = base64UrlToBytes(hs.publicKey);
    const peerKeyText = bytesToBase64Url(peerKey);
    const localKeyText = bytesToBase64Url(this.localPublicKey);

    if (peerKeyText === localKeyText) return;

    /*
     * Final handshake policy:
     *
     * - On create/join, send one initial handshake.
     * - On first valid peer handshake, send one reply handshake.
     * - After secure is established, ignore all later handshakes from same peer.
     * - If a different peer key appears after secure, fail safe.
     * - No beacon. No interval. No repeated handshakes.
     */
    if (this.secure) {
      if (
        this.peerPublicKey &&
        bytesToBase64Url(this.peerPublicKey) === peerKeyText
      ) {
        return;
      }

      this.patch({
        security: "verification_failed",
        notice: "Peer identity changed. Leave this room.",
      });
      return;
    }

    if (this.establishing) return;

    this.establishing = true;

    try {
      if (!this.replyHandshakeSent) {
        await this.sendReplyHandshake();
      }

      const negotiated = negotiateProfile(
        this.profile.id,
        hs.preferredProfile,
        hs.supportedProfiles,
      );

      this.profile = negotiated;
      this.transport.setProfile(negotiated);
      this.voice.setProfile(negotiated);
      this.sender.setProfile(negotiated);
      this.receiver.setProfile(negotiated);

      await this.runCrypto(async () => {
        await this.crypto.configure(negotiated);
        await this.crypto.establishSession(
          peerKey,
          await profileHash(negotiated),
        );
      });

      this.secure = new SecureChannel(this.crypto, negotiated);
      this.peerPublicKey = peerKey;

      const phrase = await verificationPhrase({
        localPublicKey: this.localPublicKey,
        peerPublicKey: peerKey,
        profile: negotiated,
        sessionCode: this.state.roomCode,
        peerAppVersion: hs.appVersion,
        peerFeatureFlags: hs.featureFlags,
      });

      this.patch({
        phase: "active",
        profileId: negotiated.id,
        security: "encrypted_unverified",
        safetyPhrase: phrase,
        notice: "Encrypted. Verify the phrase.",
      });

      this.addSystem("Encrypted");
    } finally {
      this.establishing = false;
    }
  }

  private async handleAppMessage(message: AppMessage): Promise<void> {
    if (isReliableEnvelope(message)) {
      const unwrapped = await this.reliable.receive(message);
      if (unwrapped) await this.handleAppMessage(unwrapped);
      return;
    }

    switch (message.kind) {
      case "session.verified":
        if (this.state.security !== "verified") {
          this.patch({ notice: "Peer marked this chat verified." });
        }
        return;

      case "text.message":
        this.addTranscript({
          id: message.messageId,
          kind: "text",
          from: "peer",
          text: message.body,
          at: message.createdAt,
          status: "sent",
        });
        return;

      case "file.offer":
        this.receiver.offer(message);
        this.ensureTransferOrder(message.fileId);
        return;

      case "file.accept":
        await this.sender.accept(message.fileId);
        return;

      case "file.reject":
        await this.sender.cancel(message.fileId, message.reason, false);
        this.startNextQueuedFileIfAllowed();
        return;

      case "file.chunk":
        await this.receiver.chunk(message);
        return;

      case "file.ack":
        this.sender.ack(message.fileId, message.index);
        return;

      case "file.nack":
        this.sender.nack(message.fileId, message.index);
        return;

      case "file.pause":
        this.sender.pause(message.fileId, message.reason);
        return;

      case "file.resume":
        this.sender.resume(message.fileId);
        return;

      case "file.cancel":
        await this.sender.cancel(message.fileId, message.reason, false);
        await this.receiver.peerCancel(message.fileId, message.reason);
        this.startNextQueuedFileIfAllowed();
        return;

      case "file.complete":
        this.receiver.completeNotice(message);
        return;

      case "voice.start":
        this.patch({ notice: "Peer started voice." });
        this.sender.setGlobalPaused(true, "paused during voice");
        return;

      case "voice.frame":
        await this.voice.play(message);
        return;

      case "voice.stop":
        this.patch({ notice: "Peer ended voice." });
        this.sender.setGlobalPaused(false);
        this.startNextQueuedFileIfAllowed();
        return;
    }
  }

  private async sendVoiceFrame(frame: VoiceFrame): Promise<void> {
    if (!this.secure || this.state.voice === "idle") return;
    await this.sendApp({ kind: "voice.frame", ...frame }, "voice");
  }

  private async sendApp(
    message: AppMessage,
    lane: LaneName,
    trackingId?: string,
  ): Promise<boolean> {
    if (shouldSendReliably(message, lane)) {
      const channel = lane === "text" ? "text" : "control";
      return this.reliable.send(message, channel, { trackingId });
    }

    return this.sendRawApp(message, lane);
  }

  private async sendRawApp(message: AppMessage, lane: LaneName): Promise<boolean> {
    if (!this.secure) return false;

    try {
      const env = await this.runCrypto(() =>
        this.secure!.encryptAppMessage(message, lane),
      );
      return this.transport.send(env);
    } catch (err) {
      console.warn("OnlyTwo send failed", err);
      return false;
    }
  }

  private async sendInitialHandshake(): Promise<void> {
    if (this.initialHandshakeSent) return;
    this.initialHandshakeSent = true;
    await this.sendHandshake();
  }

  private async sendReplyHandshake(): Promise<void> {
    if (this.replyHandshakeSent) return;
    this.replyHandshakeSent = true;
    await this.sendHandshake();
  }

  private async sendHandshake(): Promise<void> {
    if (!this.localPublicKey) return;

    const hs: HandshakeMessage = {
      kind: "handshake.v2",
      publicKey: bytesToBase64Url(this.localPublicKey),
      preferredProfile: this.profile.id,
      supportedProfiles: supportedProfileIds(),
      appVersion: APP_VERSION,
      featureFlags: [...FEATURE_FLAGS],
    };

    const env: Envelope = {
      protocolVersion: this.profile.protocolVersion,
      outerType: OuterType.HANDSHAKE,
      flags: 0,
      streamId: 0,
      sequence: 0,
      counter: 0n,
      nonce: new Uint8Array(12),
      payload: encodeHandshake(hs),
      lane: "control",
    };

    this.transport.send(env);
  }

  private updateSender(snapshot: SenderSnapshot): void {
    this.upsertTransfer({
      fileId: snapshot.fileId,
      direction: "send",
      name: snapshot.name,
      size: snapshot.size,
      progress: snapshot.progress,
      state: mapSenderStatus(snapshot.status),
      reason: snapshot.reason,
    });

    if (
      snapshot.status === "completed" ||
      snapshot.status === "cancelled" ||
      snapshot.status === "failed"
    ) {
      this.startNextQueuedFileIfAllowed();
    }
  }

  private updateReceiver(snapshot: ReceiverSnapshot): void {
    this.upsertTransfer({
      fileId: snapshot.fileId,
      direction: "receive",
      name: snapshot.name,
      size: snapshot.size,
      progress: snapshot.progress,
      state: mapReceiverStatus(snapshot.status),
      reason: snapshot.reason,
      blobUrl: snapshot.blobUrl,
    });
  }

  private upsertTransfer(view: TransferView): void {
    this.ensureTransferOrder(view.fileId);

    const existing = new Map(
      this.state.transfers.map((item) => [item.fileId, item]),
    );
    existing.set(view.fileId, view);

    this.state.transfers = this.transferOrder
      .map((id) => existing.get(id))
      .filter(Boolean) as TransferView[];

    this.emit();
  }

  private ensureTransferOrder(fileId: string): void {
    if (!this.transferOrder.includes(fileId)) {
      this.transferOrder.unshift(fileId);
    }
  }

  private hasActiveFile(): boolean {
    return this.state.transfers.some(
      (transfer) =>
        transfer.direction === "send" &&
        ["offered", "waiting", "sending", "paused", "queued"].includes(
          transfer.state,
        ),
    );
  }

  private hasActiveSendingFileExceptQueued(fileId: string): boolean {
    return this.state.transfers.some(
      (transfer) =>
        transfer.fileId !== fileId &&
        transfer.direction === "send" &&
        ["offered", "waiting", "sending", "paused"].includes(transfer.state),
    );
  }

  private startNextQueuedFileIfAllowed(): void {
    if (this.isVoiceActive()) return;
    if (this.state.connection !== "connected") return;

    const queued = this.state.transfers.find(
      (transfer) =>
        transfer.direction === "send" && transfer.state === "queued",
    );

    if (!queued) return;
    if (this.hasActiveSendingFileExceptQueued(queued.fileId)) return;

    void this.sender.startQueued(queued.fileId);
  }

  private isVoiceActive(): boolean {
    return (
      this.state.voice === "starting" ||
      this.state.voice === "active" ||
      this.state.voice === "muted"
    );
  }

  private updateTranscriptStatus(id: string, status: "sending" | "sent" | "failed"): void {
    this.state.transcript = this.state.transcript.map((item) =>
      item.id === id ? { ...item, status } : item,
    );
    this.emit();
  }

  private addTranscript(item: SessionViewState["transcript"][number]): void {
    this.state.transcript = [...this.state.transcript, item];
    this.emit();
  }

  private addSystem(text: string): void {
    const recentSystems = this.state.transcript
      .filter((item) => item.kind === "system")
      .slice(-MAX_SYSTEM_ITEMS + 1);

    const nonSystems = this.state.transcript.filter(
      (item) => item.kind !== "system",
    );

    const item: SessionViewState["transcript"][number] = {
      id: makeId("sys"),
      kind: "system",
      from: "system",
      text,
      at: Date.now(),
    };

    this.state.transcript = [...nonSystems, ...recentSystems, item].sort(
      (a, b) => a.at - b.at,
    );

    this.emit();
  }

  private patch(patch: Partial<SessionViewState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private snapshot(): SessionViewState {
    return {
      ...this.state,
      transcript: [...this.state.transcript],
      transfers: [...this.state.transfers],
    };
  }

  private runCrypto<T>(task: () => Promise<T>): Promise<T> {
    const run = this.cryptoSerial.then(task, task);
    this.cryptoSerial = run.catch(() => undefined);
    return run;
  }
}

function mapSenderStatus(
  status: SenderSnapshot["status"],
): TransferView["state"] {
  switch (status) {
    case "offered":
      return "waiting";
    case "sending":
      return "sending";
    case "paused":
      return "paused";
    case "queued":
      return "queued";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

function mapReceiverStatus(
  status: ReceiverSnapshot["status"],
): TransferView["state"] {
  switch (status) {
    case "offered":
      return "offered";
    case "receiving":
      return "receiving";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}
