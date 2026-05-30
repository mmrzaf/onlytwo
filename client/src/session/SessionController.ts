import {
  getProfile,
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
import { VoiceFreshnessQueue } from "../features/audio/VoiceQueue";
import {
  APP_VERSION,
  decodeHandshake,
  encodeHandshake,
  FEATURE_FLAGS,
  type AppMessage,
  type HandshakeMessage,
} from "../protocol/appMessages";
import { OuterType, type Envelope } from "../protocol/envelope";
import type { RelayEvent } from "../protocol/relayControl";
import { profileHash, verificationPhrase } from "../protocol/negotiation";
import { createRoom as createRelayRoom, lookupRoom } from "../protocol/rooms";
import {
  ReliableChannel,
  isReliableEnvelope,
  shouldSendReliably,
} from "../protocol/reliable";
import { validateInboundStream } from "../protocol/streams";
import {
  WebSocketConnection,
  type ConnectionStatus,
} from "../transport/WebSocketConnection";
import { base64UrlToBytes, bytesToBase64Url } from "../utils/bytes";
import { makeId, normalizeRoomCode } from "../utils/ids";
import type { SessionViewState, StateListener, TransferView } from "./types";

const MAX_TRANSCRIPT_ITEMS = 500;
const MAX_RETAINED_TRANSFERS = 30;
const END_SESSION_FALLBACK_MS = 1500;

export class SessionController {
  private profile: TransportProfile = getProfile("balanced");
  private crypto = new CryptoClient();
  private secure: SecureChannel | null = null;
  private transport = new WebSocketConnection(this.profile);
  private voice = new VoiceService(this.profile, (reason) =>
    this.transport.recordVoiceDrop(reason),
  );
  private outboundVoice = this.createVoiceQueue<VoiceFrame>();
  private inboundVoice = this.createVoiceQueue<Envelope>();
  private outboundVoicePumping = false;
  private inboundVoiceScheduled = false;
  private voiceQueueEpoch = 0;
  private inboundSerial: Promise<unknown> = Promise.resolve();
  private epochPreparation: Promise<void> | null = null;
  private lifecycleEpoch = 0;
  private secureEpoch = 0;
  private startupInFlight = false;
  private endSessionTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteVoiceActive = false;

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
      this.addSystem(reason, "error");
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
    audioPlaybackBlocked: false,
    invalidPackets: 0,
    transcript: [],
    transfers: [],
  };

  constructor() {
    this.transport.onStatus((status) => {
      const lifecycle = this.lifecycleEpoch;
      this.enqueueInbound(() =>
        lifecycle === this.lifecycleEpoch
          ? this.onConnectionStatus(status)
          : undefined,
      );
    });
    this.transport.onRelayEvent((event) => {
      const lifecycle = this.lifecycleEpoch;
      this.enqueueInbound(() =>
        lifecycle === this.lifecycleEpoch
          ? this.onRelayEvent(event)
          : undefined,
      );
    });
    this.transport.onEnvelope((env) => this.routeEnvelope(env));
    window.addEventListener("beforeunload", () => this.disconnect(true));
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  setProfile(id: TransportProfileId): void {
    if (this.state.phase !== "idle" && this.state.phase !== "ended") return;

    this.profile = getProfile(id);
    this.transport.setProfile(this.profile);
    this.voice.setProfile(this.profile);
    this.sender.setProfile(this.profile);
    this.receiver.setProfile(this.profile);
    this.updateVoiceQueueLimits();

    this.patch({ profileId: id });
  }

  async createRoom(): Promise<void> {
    if (this.startupInFlight) return;
    this.startupInFlight = true;
    try {
      this.patch({ phase: "creating", notice: "Creating room…" });
      const room = await createRelayRoom(this.state.profileId);
      await this.start(room.code, "creating", room.profileId);
    } catch (err) {
      this.disconnect(true);
      this.patch({ phase: "idle", roomCode: "", notice: errorMessage(err) });
      throw err;
    } finally {
      this.startupInFlight = false;
    }
  }

  async joinRoom(rawCode: string): Promise<void> {
    if (this.startupInFlight) return;
    const code = normalizeRoomCode(rawCode);
    if (code.length !== 9) throw new Error("Enter the full room code");
    this.startupInFlight = true;
    try {
      this.patch({ phase: "joining", notice: "Looking up room…" });
      const room = await lookupRoom(code);
      await this.start(room.code, "joining", room.profileId);
    } catch (err) {
      this.disconnect(true);
      this.patch({ phase: "idle", roomCode: "", notice: errorMessage(err) });
      throw err;
    } finally {
      this.startupInFlight = false;
    }
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

  removeFile(fileId: string): void {
    const transfer = this.state.transfers.find(
      (item) => item.fileId === fileId,
    );
    if (
      !transfer ||
      !["completed", "cancelled", "failed"].includes(transfer.state)
    )
      return;
    this.sender.remove(fileId);
    this.receiver.remove(fileId);
    this.removeTransferView(fileId);
    this.emit();
  }

  async startVoice(): Promise<void> {
    if (!this.secure) {
      this.patch({ notice: "Encryption is not ready." });
      return;
    }
    if (this.state.voice !== "idle") return;

    this.clearVoiceQueues();
    this.patch({
      voice: "starting",
      audioPlaybackBlocked: false,
      notice: "Starting voice…",
    });
    this.updateFilePauseForVoice();

    try {
      await this.voice.start((frame) => this.queueOutboundVoice(frame));
      this.patch({
        voice: "active",
        muted: false,
        audioPlaybackBlocked: false,
        notice: "Voice active. Files are paused.",
      });
      this.addSystem("Voice started.");
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
      this.clearVoiceQueues();
      this.voice.stop();
      const reason = err instanceof Error ? err.message : "Voice failed";
      this.patch({
        voice: "failed",
        notice: reason,
      });
      this.updateFilePauseForVoice();
      this.addSystem(`Voice unavailable: ${reason}`, "error");
      setTimeout(() => {
        if (this.state.voice === "failed") this.patch({ voice: "idle" });
      }, 2500);
    }
  }

  async stopVoice(): Promise<void> {
    if (this.state.voice === "idle") return;
    this.clearVoiceQueues();
    this.voice.stop();
    await this.sendApp({ kind: "voice.stop", streamId: "voice" }, "control");
    this.patch({
      voice: "idle",
      muted: false,
      audioPlaybackBlocked: false,
      notice: "Voice ended.",
    });
    this.updateFilePauseForVoice();
    this.addSystem("Voice ended.");
  }

  toggleMute(): void {
    if (this.state.voice !== "active" && this.state.voice !== "muted") return;
    const muted = !this.state.muted;
    this.voice.setMuted(muted);
    if (muted) this.clearOutboundVoiceQueue();
    this.patch({ muted, voice: muted ? "muted" : "active" });
  }

  async enableAudioPlayback(): Promise<void> {
    const enabled = await this.voice.enablePlayback();
    this.patch({
      audioPlaybackBlocked: !enabled,
      notice: enabled
        ? "Audio playback enabled."
        : "Audio playback is still blocked by this browser.",
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
        notice: "Verification mismatch. End this chat.",
      });
      this.addSystem("Verification mismatch. End this chat.", "error");
      return;
    }

    this.patch({
      security: "verified",
      notice: "Verified on this device.",
    });

    this.addSystem("Secure session verified.");
    await this.sendApp({ kind: "session.verified", at: Date.now() }, "control");
  }

  endChatForBoth(): void {
    if (this.state.phase === "idle" || this.state.phase === "ended") return;
    if (this.endSessionTimer) clearTimeout(this.endSessionTimer);
    const sent = this.transport.endSession();
    if (!sent) {
      this.disconnect(false, true, "Chat ended on this device.");
      return;
    }
    this.patch({ notice: "Ending chat for both…" });
    this.endSessionTimer = setTimeout(() => {
      this.endSessionTimer = null;
      this.disconnect(false, true, "Chat ended for both.");
    }, END_SESSION_FALLBACK_MS);
  }

  disconnect(
    silent = false,
    forgetSlot = false,
    notice = "Room closed on this device.",
  ): void {
    this.lifecycleEpoch += 1;
    this.secureEpoch += 1;
    if (this.endSessionTimer) clearTimeout(this.endSessionTimer);
    this.endSessionTimer = null;
    this.establishing = false;
    this.initialHandshakeSent = false;
    this.replyHandshakeSent = false;
    this.epochPreparation = null;

    this.remoteVoiceActive = false;
    this.clearVoiceQueues();
    this.voice.stop();
    this.sender.reset();
    this.receiver.reset();
    this.transport.disconnect({ forgetSlot });

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
        audioPlaybackBlocked: false,
        notice,
        transcript: [],
        transfers: [],
      });
    }
  }

  private async start(
    code: string,
    phase: "creating" | "joining",
    selectedProfileId: TransportProfileId,
  ): Promise<void> {
    this.disconnect(true);
    const lifecycle = this.lifecycleEpoch;

    this.profile = getProfile(selectedProfileId);
    this.transport.setProfile(this.profile);
    this.voice.setProfile(this.profile);
    this.sender.setProfile(this.profile);
    this.receiver.setProfile(this.profile);
    this.updateVoiceQueueLimits();

    this.transferOrder = [];
    this.remoteVoiceActive = false;
    this.reliable.reset();
    this.initialHandshakeSent = false;
    this.replyHandshakeSent = false;
    this.establishing = false;

    this.patch({
      phase,
      roomCode: code,
      profileId: selectedProfileId,
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
      audioPlaybackBlocked: false,
    });

    await this.crypto.configure(this.profile);
    const localPublicKey = await this.crypto.generateIdentity();
    if (lifecycle !== this.lifecycleEpoch) return;
    this.localPublicKey = localPublicKey;
    await this.transport.connect(code);
    if (lifecycle !== this.lifecycleEpoch) return;

    this.patch({ phase: "waiting", notice: "Waiting for the other person." });
    await this.sendInitialHandshake();
  }

  private async onConnectionStatus(status: ConnectionStatus): Promise<void> {
    this.patch({ connection: status });

    if (status === "reconnecting") {
      await this.prepareFreshCryptoEpoch(
        "Connection interrupted. Reconnecting securely…",
      );
      return;
    }

    if (status === "connected") {
      if (!this.localPublicKey)
        await this.prepareFreshCryptoEpoch(
          "Establishing a fresh secure session…",
        );
      if (this.localPublicKey && !this.secure && !this.initialHandshakeSent)
        await this.sendInitialHandshake();
      this.updateFilePauseForVoice();
      return;
    }

    if (status === "failed") {
      this.patch({ phase: "failed", notice: "Connection lost." });
      this.addSystem("Connection lost.", "error");
    }
  }

  private async onRelayEvent(event: RelayEvent): Promise<void> {
    switch (event.kind) {
      case "peer.present":
        if (this.secure || this.peerPublicKey || !this.localPublicKey) {
          await this.prepareFreshCryptoEpoch(
            "Establishing a fresh secure session…",
          );
        }
        await this.sendInitialHandshake();
        return;
      case "peer.disconnected":
        await this.prepareFreshCryptoEpoch(
          "Peer disconnected. Waiting for rejoin…",
        );
        this.patch({
          phase: "waiting",
          notice: "Peer disconnected. Waiting for rejoin…",
        });
        this.addSystem("Peer disconnected. Waiting for rejoin.");
        return;
      case "peer.rejoined":
        await this.prepareFreshCryptoEpoch(
          "Peer rejoined. Establishing a new secure session…",
        );
        this.addSystem("Peer rejoined. New secure session started.");
        await this.sendInitialHandshake();
        return;
      case "session.ended":
        this.disconnect(false, true, "Chat ended for both.");
        return;
    }
  }

  private routeEnvelope(env: Envelope): void {
    const epoch = this.secureEpoch;
    if (env.outerType === OuterType.DATA && env.streamId === 4) {
      this.queueInboundVoice(env, epoch);
      return;
    }
    this.enqueueInbound(() => this.onEnvelope(env, epoch));
  }

  private queueInboundVoice(env: Envelope, epoch: number): void {
    if (epoch !== this.secureEpoch || !this.secure) {
      this.transport.recordVoiceDrop("before_decrypt");
      return;
    }
    const dropped = this.inboundVoice.push(env);
    if (dropped) this.transport.recordVoiceDrop("before_decrypt", dropped);
    this.transport.recordVoiceQueueSize(this.inboundVoice.size);
    this.scheduleInboundVoice();
  }

  private scheduleInboundVoice(): void {
    if (this.inboundVoiceScheduled) return;
    this.inboundVoiceScheduled = true;
    this.enqueueInbound(() => this.processOneInboundVoice());
  }

  private async processOneInboundVoice(): Promise<void> {
    try {
      const next = this.inboundVoice.shiftFresh();
      if (next.dropped)
        this.transport.recordVoiceDrop("before_decrypt", next.dropped);
      if (next.value) await this.onEnvelope(next.value, this.secureEpoch);
    } finally {
      this.inboundVoiceScheduled = false;
      if (this.inboundVoice.size > 0) this.scheduleInboundVoice();
    }
  }

  private enqueueInbound(task: () => Promise<void> | void): void {
    const run = () => Promise.resolve(task());
    const next = this.inboundSerial.then(run, run);
    this.inboundSerial = next.catch((err) =>
      console.warn("OnlyTwo inbound task failed", err),
    );
  }

  private async prepareFreshCryptoEpoch(notice: string): Promise<void> {
    if (this.epochPreparation) return this.epochPreparation;
    const lifecycle = this.lifecycleEpoch;
    const work = (async () => {
      this.secureEpoch += 1;
      this.establishing = false;
      this.initialHandshakeSent = false;
      this.replyHandshakeSent = false;
      this.transport.clearQueuedPackets();
      this.remoteVoiceActive = false;
      this.clearVoiceQueues();
      this.voice.stop();
      this.sender.reset();
      this.receiver.reset();
      this.transferOrder = [];
      this.reliable.failAll(
        "Session changed. Unsent messages were not delivered.",
      );
      this.reliable.reset();
      this.secure = null;
      this.localPublicKey = null;
      this.peerPublicKey = null;
      this.cryptoSerial = Promise.resolve();
      this.patch({
        phase: "waiting",
        security: "none",
        safetyPhrase: null,
        voice: "idle",
        muted: false,
        audioPlaybackBlocked: false,
        transfers: [],
        transcript: this.state.transcript.filter(
          (item) => item.kind !== "file",
        ),
        notice,
      });

      await this.crypto.reset().catch(() => undefined);
      if (lifecycle !== this.lifecycleEpoch) return;
      await this.crypto.configure(this.profile);
      const key = await this.crypto.generateIdentity();
      if (lifecycle !== this.lifecycleEpoch) return;
      this.localPublicKey = key;
      if (this.transport.status === "connected")
        await this.sendInitialHandshake();
    })();
    this.epochPreparation = work;
    try {
      await work;
    } finally {
      if (this.epochPreparation === work) this.epochPreparation = null;
    }
  }

  private async onEnvelope(env: Envelope, epoch: number): Promise<void> {
    if (epoch !== this.secureEpoch) return;
    try {
      if (env.outerType === OuterType.HANDSHAKE) {
        if (env.streamId !== 0) throw new Error("Invalid handshake stream");
        await this.handleHandshake(env.payload);
        return;
      }

      const secure = this.secure;
      if (!secure) return;

      const message = await this.runCrypto(() => secure.decryptAppMessage(env));
      if (epoch !== this.secureEpoch || secure !== this.secure) return;
      validateInboundStream(message, env.streamId);
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

      const expectedProfileHash = await profileHash(this.profile);
      const missingFeatures = FEATURE_FLAGS.filter(
        (flag) => !hs.featureFlags.includes(flag),
      );
      if (
        hs.appVersion !== APP_VERSION ||
        hs.profileId !== this.profile.id ||
        hs.profileHash !== expectedProfileHash ||
        missingFeatures.length > 0
      ) {
        this.patch({
          security: "verification_failed",
          notice:
            "This peer is using an incompatible OnlyTwo version. Refresh both browsers.",
        });
        this.addSystem(
          "This peer is using an incompatible OnlyTwo version. Refresh both browsers.",
          "error",
        );
        return;
      }

      await this.runCrypto(async () => {
        await this.crypto.configure(this.profile);
        await this.crypto.establishSession(peerKey, expectedProfileHash);
      });

      this.secure = new SecureChannel(this.crypto, this.profile);
      this.peerPublicKey = peerKey;

      const phrase = await verificationPhrase({
        localPublicKey: this.localPublicKey,
        peerPublicKey: peerKey,
        profile: this.profile,
        sessionCode: this.state.roomCode,
        peerAppVersion: hs.appVersion,
        peerFeatureFlags: hs.featureFlags,
      });

      this.patch({
        phase: "active",
        profileId: this.profile.id,
        security: "encrypted_unverified",
        safetyPhrase: phrase,
        notice: "Encrypted. Verify the phrase.",
        invalidPackets: 0,
      });

      this.addSystem("Secure session ready. Verify the safety phrase.");
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
          this.addSystem("Peer marked the secure session as verified.");
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
        this.sender.nack(message.fileId, message.index, message.reason);
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
        this.validateRemoteVoiceStart(message);
        this.remoteVoiceActive = true;
        this.patch({ notice: "Peer started voice." });
        this.addSystem("Peer started voice.");
        this.updateFilePauseForVoice();
        return;

      case "voice.frame": {
        if (!this.remoteVoiceActive)
          throw new Error("Voice frame received before voice start");
        const playing = await this.voice.play(message);
        if (!playing && !this.state.audioPlaybackBlocked) {
          this.patch({
            audioPlaybackBlocked: true,
            notice: "Incoming voice is blocked. Tap Enable audio.",
          });
          this.addSystem(
            "Incoming voice is blocked. Tap Enable audio.",
            "error",
          );
        }
        return;
      }

      case "voice.stop":
        if (message.streamId !== "voice")
          throw new Error("Invalid voice stream metadata");
        this.remoteVoiceActive = false;
        this.inboundVoice.clear();
        this.voice.stopPlayback();
        this.patch({
          audioPlaybackBlocked: false,
          notice: "Peer ended voice.",
        });
        this.updateFilePauseForVoice();
        this.addSystem("Peer ended voice.");
        return;
    }
  }

  private queueOutboundVoice(frame: VoiceFrame): void {
    if (!this.secure || this.state.voice === "idle" || this.state.muted) return;
    const dropped = this.outboundVoice.push(frame);
    if (dropped) this.transport.recordVoiceDrop("before_encrypt", dropped);
    this.transport.recordVoiceQueueSize(this.outboundVoice.size);
    void this.pumpOutboundVoice();
  }

  private async pumpOutboundVoice(): Promise<void> {
    if (this.outboundVoicePumping) return;
    this.outboundVoicePumping = true;
    const epoch = this.voiceQueueEpoch;
    try {
      while (
        epoch === this.voiceQueueEpoch &&
        this.secure &&
        this.state.voice !== "idle" &&
        !this.state.muted
      ) {
        const next = this.outboundVoice.shiftFresh();
        if (next.dropped)
          this.transport.recordVoiceDrop("before_encrypt", next.dropped);
        if (!next.value) return;
        if (!this.transport.canSendVoiceNow()) {
          const dropped = 1 + this.outboundVoice.clear();
          this.transport.recordVoiceDrop("before_encrypt", dropped);
          return;
        }
        await this.sendRawApp({ kind: "voice.frame", ...next.value }, "voice");
      }
    } finally {
      this.outboundVoicePumping = false;
      if (
        epoch === this.voiceQueueEpoch &&
        this.outboundVoice.size > 0 &&
        this.state.voice !== "idle" &&
        !this.state.muted
      ) {
        void this.pumpOutboundVoice();
      }
    }
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

  private async sendRawApp(
    message: AppMessage,
    lane: LaneName,
  ): Promise<boolean> {
    const secure = this.secure;
    const epoch = this.secureEpoch;
    if (!secure) return false;
    if (lane === "voice" && !this.transport.canSendVoiceNow()) {
      this.transport.recordVoiceDrop("before_encrypt");
      return false;
    }

    try {
      const env = await this.runCrypto(() =>
        secure.encryptAppMessage(message, lane),
      );
      if (epoch !== this.secureEpoch || secure !== this.secure) return false;
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
    const localPublicKey = this.localPublicKey;
    const lifecycle = this.lifecycleEpoch;
    const epoch = this.secureEpoch;
    const profile = this.profile;
    if (!localPublicKey) return;

    const profileHashValue = await profileHash(profile);
    if (
      lifecycle !== this.lifecycleEpoch ||
      epoch !== this.secureEpoch ||
      localPublicKey !== this.localPublicKey ||
      profile !== this.profile
    ) {
      return;
    }

    const hs: HandshakeMessage = {
      kind: "handshake.v2",
      publicKey: bytesToBase64Url(localPublicKey),
      profileId: profile.id,
      profileHash: profileHashValue,
      appVersion: APP_VERSION,
      featureFlags: [...FEATURE_FLAGS],
    };

    const env: Envelope = {
      protocolVersion: profile.protocolVersion,
      outerType: OuterType.HANDSHAKE,
      flags: 0,
      streamId: 0,
      sequence: 0,
      counter: 0n,
      nonce: new Uint8Array(12),
      payload: encodeHandshake(hs),
      lane: "control",
    };

    if (!this.transport.send(env)) {
      throw new Error("Could not queue secure handshake");
    }
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

    if (
      !this.state.transcript.some(
        (item) => item.kind === "file" && item.fileId === view.fileId,
      )
    ) {
      this.state.transcript = trimTranscript([
        ...this.state.transcript,
        {
          id: makeId("file"),
          kind: "file",
          from: view.direction === "send" ? "me" : "peer",
          text: view.name,
          at: Date.now(),
          fileId: view.fileId,
        },
      ]);
    }

    this.trimRetainedTransfers();
    this.emit();
  }

  private removeTransferView(fileId: string): void {
    this.state.transfers = this.state.transfers.filter(
      (item) => item.fileId !== fileId,
    );
    this.state.transcript = this.state.transcript.filter(
      (item) => !(item.kind === "file" && item.fileId === fileId),
    );
    this.transferOrder = this.transferOrder.filter((id) => id !== fileId);
  }

  private trimRetainedTransfers(): void {
    const retained = this.transferOrder.filter((id) =>
      this.state.transfers.some(
        (item) =>
          item.fileId === id &&
          ["completed", "cancelled", "failed"].includes(item.state),
      ),
    );
    for (const fileId of retained.slice(MAX_RETAINED_TRANSFERS)) {
      this.sender.remove(fileId);
      this.receiver.remove(fileId);
      this.removeTransferView(fileId);
    }
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
    if (this.isVoiceActive() || this.remoteVoiceActive) return;
    if (this.state.connection !== "connected") return;

    const queued = [...this.state.transfers]
      .reverse()
      .find(
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

  private updateTranscriptStatus(
    id: string,
    status: "sending" | "sent" | "failed",
  ): void {
    this.state.transcript = this.state.transcript.map((item) =>
      item.id === id ? { ...item, status } : item,
    );
    this.emit();
  }

  private addTranscript(item: SessionViewState["transcript"][number]): void {
    this.state.transcript = trimTranscript([...this.state.transcript, item]);
    this.emit();
  }

  private addSystem(text: string, severity: "info" | "error" = "info"): void {
    const previous = this.state.transcript.at(-1);
    if (
      previous?.kind === "system" &&
      previous.text === text &&
      previous.severity === severity
    ) {
      return;
    }

    this.state.transcript = trimTranscript([
      ...this.state.transcript,
      {
        id: makeId("sys"),
        kind: "system",
        from: "system",
        text,
        at: Date.now(),
        severity,
      },
    ]);

    this.emit();
  }

  private validateRemoteVoiceStart(
    message: Extract<AppMessage, { kind: "voice.start" }>,
  ): void {
    if (
      message.streamId !== "voice" ||
      message.frameMs !== this.profile.voice.frameMs ||
      (message.mode !== undefined &&
        message.mode !== this.profile.voice.mode) ||
      message.sampleRate < 8_000 ||
      message.sampleRate > 192_000
    ) {
      throw new Error("Invalid voice stream metadata");
    }
  }

  private updateFilePauseForVoice(): void {
    const shouldPause = this.isVoiceActive() || this.remoteVoiceActive;
    this.sender.setGlobalPaused(shouldPause, "Paused during voice");
    if (!shouldPause) this.startNextQueuedFileIfAllowed();
  }

  private createVoiceQueue<T>(): VoiceFreshnessQueue<T> {
    return new VoiceFreshnessQueue<T>(
      this.voiceQueueMaxFrames(),
      this.profile.voice.maxQueuedLatencyMs,
    );
  }

  private updateVoiceQueueLimits(): void {
    const maxFrames = this.voiceQueueMaxFrames();
    const outboundDropped = this.outboundVoice.setLimits(
      maxFrames,
      this.profile.voice.maxQueuedLatencyMs,
    );
    const inboundDropped = this.inboundVoice.setLimits(
      maxFrames,
      this.profile.voice.maxQueuedLatencyMs,
    );
    if (outboundDropped)
      this.transport.recordVoiceDrop("before_encrypt", outboundDropped);
    if (inboundDropped)
      this.transport.recordVoiceDrop("before_decrypt", inboundDropped);
  }

  private voiceQueueMaxFrames(): number {
    return Math.max(
      1,
      Math.ceil(
        this.profile.voice.maxQueuedLatencyMs / this.profile.voice.frameMs,
      ),
    );
  }

  private clearOutboundVoiceQueue(): void {
    this.voiceQueueEpoch += 1;
    const dropped = this.outboundVoice.clear();
    if (dropped) this.transport.recordVoiceDrop("before_encrypt", dropped);
  }

  private clearVoiceQueues(): void {
    this.clearOutboundVoiceQueue();
    const inboundDropped = this.inboundVoice.clear();
    if (inboundDropped)
      this.transport.recordVoiceDrop("before_decrypt", inboundDropped);
    this.inboundVoiceScheduled = false;
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

function trimTranscript(
  items: SessionViewState["transcript"],
): SessionViewState["transcript"] {
  return items.length <= MAX_TRANSCRIPT_ITEMS
    ? items
    : items.slice(items.length - MAX_TRANSCRIPT_ITEMS);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
