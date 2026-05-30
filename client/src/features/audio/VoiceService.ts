import type { TransportProfile } from "../../config/profiles";
import { bytesToPayload, payloadToBytes } from "../../protocol/appMessages";
import { JitterBuffer } from "./JitterBuffer";
import { floatToPcm16, pcm16ToFloat } from "./pcm";
import { VadGate, framesFromMs } from "./VadGate";

const WORKLET_CODE = `
class OnlyTwoCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) this.port.postMessage(input.slice(0));
    return true;
  }
}
registerProcessor('onlytwo-capture', OnlyTwoCaptureProcessor);
`;

export interface VoiceFrame {
  streamId: string;
  seq: number;
  sentAt: number;
  sampleRate: number;
  frameMs: number;
  pcm16: string;
}

interface PlaybackFrame {
  seq: number;
  frame: VoiceFrame;
  pcm16: Uint8Array;
  receivedAt: number;
}

export type VoiceDropReason = "playback_stale" | "playback_lead_reset";
export type VoiceStatus = "idle" | "requesting" | "active" | "muted" | "failed";

export class VoiceService {
  private stream: MediaStream | null = null;
  private inputCtx: AudioContext | null = null;
  private outputCtx: AudioContext | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private zeroGain: GainNode | null = null;
  private seq = 0;
  private muted = false;
  private captureBuffer: Float32Array[] = [];
  private captureSamples = 0;
  private jitter: JitterBuffer<PlaybackFrame>;
  private playbackTimer: ReturnType<typeof setInterval> | null = null;
  private nextPlaybackTime = 0;
  private streamId = "voice";
  private vad: VadGate;
  private playbackBlockedValue = false;
  private scheduledSources = new Set<AudioBufferSourceNode>();

  constructor(
    private profile: TransportProfile,
    private readonly onDrop: (reason: VoiceDropReason) => void = () =>
      undefined,
  ) {
    this.jitter = new JitterBuffer<PlaybackFrame>(
      profile.voice.jitterMaxFrames,
    );
    this.vad = new VadGate(this.vadConfig(profile));
  }

  setProfile(profile: TransportProfile): void {
    this.profile = profile;
    this.jitter = new JitterBuffer<PlaybackFrame>(
      profile.voice.jitterMaxFrames,
    );
    this.vad.setConfig(this.vadConfig(profile));
  }

  get active(): boolean {
    return !!this.stream;
  }
  get isMuted(): boolean {
    return this.muted;
  }
  get actualSampleRate(): number {
    return this.inputCtx?.sampleRate ?? 48_000;
  }
  get playbackBlocked(): boolean {
    return this.playbackBlockedValue;
  }

  async start(onFrame: (frame: VoiceFrame) => void): Promise<void> {
    if (this.stream) return;
    if (!this.profile.voice.enabled)
      throw new Error("Voice is disabled in this profile");
    if (!window.isSecureContext)
      throw new Error("Voice requires a secure HTTPS page");
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("This browser does not expose microphone access");
    if (typeof window.AudioContext !== "function")
      throw new Error("This browser does not support Web Audio");
    if (typeof AudioWorkletNode !== "function")
      throw new Error(
        "This browser does not support the current voice engine (AudioWorklet missing)",
      );

    let stage = "audio_context_resume";
    try {
      this.inputCtx = new AudioContext();
      this.outputCtx = new AudioContext();
      await this.resumeContext(this.inputCtx);
      await this.resumeContext(this.outputCtx);
      this.playbackBlockedValue = false;

      if (!this.inputCtx.audioWorklet) {
        throw new Error(
          "This browser does not support the current voice engine (AudioWorklet missing)",
        );
      }

      stage = "microphone_permission";
      this.stream = await this.requestMicrophone();

      stage = "audio_worklet_load";
      const workletUrl = URL.createObjectURL(
        new Blob([WORKLET_CODE], { type: "text/javascript" }),
      );
      try {
        await this.inputCtx.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }

      this.captureNode = new AudioWorkletNode(this.inputCtx, "onlytwo-capture");
      this.sourceNode = this.inputCtx.createMediaStreamSource(this.stream);
      this.zeroGain = this.inputCtx.createGain();
      this.zeroGain.gain.value = 0;

      this.sourceNode.connect(this.captureNode);
      this.captureNode.connect(this.zeroGain);
      this.zeroGain.connect(this.inputCtx.destination);

      this.seq = 0;
      this.vad.reset();

      const sampleRate = this.inputCtx.sampleRate;
      const samplesPerFrame = Math.max(
        320,
        Math.floor((sampleRate * this.profile.voice.frameMs) / 1000),
      );

      this.captureNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!this.stream || this.muted) return;

        this.captureBuffer.push(event.data);
        this.captureSamples += event.data.length;

        while (this.captureSamples >= samplesPerFrame) {
          const frame = this.readFrame(samplesPerFrame);
          for (const outboundFrame of this.framesAllowedByVoiceMode(frame)) {
            onFrame({
              streamId: this.streamId,
              seq: ++this.seq,
              sentAt: Date.now(),
              sampleRate,
              frameMs: this.profile.voice.frameMs,
              pcm16: bytesToPayload(floatToPcm16(outboundFrame)),
            });
          }
        }
      };
    } catch (err) {
      this.stop();
      throw voiceError(stage, err);
    }
  }

  stop(): void {
    this.muted = false;
    this.captureBuffer = [];
    this.captureSamples = 0;
    this.vad.reset();
    this.stopPlayback();

    try {
      this.captureNode?.disconnect();
    } catch {}
    try {
      this.sourceNode?.disconnect();
    } catch {}
    try {
      this.zeroGain?.disconnect();
    } catch {}

    this.captureNode = null;
    this.sourceNode = null;
    this.zeroGain = null;

    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;

    void this.inputCtx?.close().catch(() => undefined);
    void this.outputCtx?.close().catch(() => undefined);
    this.inputCtx = null;
    this.outputCtx = null;
    this.playbackBlockedValue = false;
  }

  stopPlayback(): void {
    this.jitter.clear();
    this.nextPlaybackTime = 0;
    if (this.playbackTimer !== null) clearInterval(this.playbackTimer);
    this.playbackTimer = null;
    for (const source of this.scheduledSources) {
      try {
        source.stop();
      } catch {}
      try {
        source.disconnect();
      } catch {}
    }
    this.scheduledSources.clear();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.captureBuffer = [];
    this.captureSamples = 0;
    this.vad.reset();
  }

  async enablePlayback(): Promise<boolean> {
    try {
      if (!this.outputCtx) this.outputCtx = new AudioContext();
      await this.resumeContext(this.outputCtx);
      this.playbackBlockedValue = false;
      return true;
    } catch {
      this.playbackBlockedValue = true;
      return false;
    }
  }

  async play(frame: VoiceFrame): Promise<boolean> {
    const pcm16 = decodeInboundVoiceFrame(frame, this.profile);
    if (!(await this.enablePlayback())) return false;

    this.jitter.push({
      seq: frame.seq,
      frame,
      pcm16,
      receivedAt: performance.now(),
    });

    if (this.playbackTimer === null && this.outputCtx) {
      this.nextPlaybackTime =
        this.outputCtx.currentTime + this.profile.voice.jitterTargetMs / 1000;
      this.playbackTimer = setInterval(
        () => this.flushPlayback(),
        this.profile.voice.frameMs,
      );
    }
    return true;
  }

  private async requestMicrophone(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "OverconstrainedError") {
        try {
          return await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });
        } catch (fallbackErr) {
          throw voiceError("microphone_constraints", fallbackErr);
        }
      }
      throw err;
    }
  }

  private async resumeContext(ctx: AudioContext): Promise<void> {
    if (ctx.state !== "running") await ctx.resume();
    if (ctx.state !== "running")
      throw new Error("Audio playback is blocked. Tap Enable audio and retry.");
  }

  private flushPlayback(): void {
    if (!this.outputCtx) return;

    const maxLatencyMs = this.profile.voice.maxQueuedLatencyMs;
    const maxLeadSeconds = maxLatencyMs / 1000;
    if (this.nextPlaybackTime - this.outputCtx.currentTime > maxLeadSeconds) {
      this.jitter.clear();
      this.nextPlaybackTime =
        this.outputCtx.currentTime + this.profile.voice.jitterTargetMs / 1000;
      this.onDrop("playback_lead_reset");
      return;
    }

    let item = this.jitter.pop();
    while (item && performance.now() - item.receivedAt > maxLatencyMs) {
      this.onDrop("playback_stale");
      item = this.jitter.pop();
    }
    if (!item) return;

    const frame = item.frame;
    const floats = pcm16ToFloat(item.pcm16);
    const buffer = this.outputCtx.createBuffer(
      1,
      floats.length,
      frame.sampleRate,
    );
    buffer.copyToChannel(floats, 0);

    const source = this.outputCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outputCtx.destination);
    this.scheduledSources.add(source);
    source.onended = () => {
      this.scheduledSources.delete(source);
      try {
        source.disconnect();
      } catch {}
    };

    const startAt = Math.max(this.outputCtx.currentTime, this.nextPlaybackTime);
    source.start(startAt);
    this.nextPlaybackTime = startAt + frame.frameMs / 1000;
  }

  private readFrame(samplesPerFrame: number): Float32Array {
    const frame = new Float32Array(samplesPerFrame);
    let offset = 0;

    while (offset < samplesPerFrame) {
      const first = this.captureBuffer[0];
      const take = Math.min(first.length, samplesPerFrame - offset);
      frame.set(first.subarray(0, take), offset);
      offset += take;

      if (take === first.length) this.captureBuffer.shift();
      else this.captureBuffer[0] = first.slice(take);

      this.captureSamples -= take;
    }

    return frame;
  }

  private framesAllowedByVoiceMode(frame: Float32Array): Float32Array[] {
    if (this.profile.voice.mode === "maximum_privacy") return [frame];
    const decision = this.vad.process(frame);
    return decision.send ? decision.frames : [];
  }

  private vadConfig(profile: TransportProfile) {
    return {
      enabled: profile.voice.vadEnabled && profile.voice.mode === "efficient",
      startDb: profile.voice.vadStartDb,
      stopDb: profile.voice.vadStopDb,
      preRollFrames: framesFromMs(
        profile.voice.vadPreRollMs,
        profile.voice.frameMs,
      ),
      hangoverFrames: framesFromMs(
        profile.voice.vadHangoverMs,
        profile.voice.frameMs,
      ),
      minSpeechFrames: framesFromMs(
        profile.voice.vadMinSpeechMs,
        profile.voice.frameMs,
      ),
    };
  }
}

export function decodeInboundVoiceFrame(
  frame: VoiceFrame,
  profile: TransportProfile,
): Uint8Array {
  if (
    frame.streamId !== "voice" ||
    !Number.isSafeInteger(frame.seq) ||
    frame.seq <= 0 ||
    !Number.isSafeInteger(frame.sampleRate) ||
    frame.sampleRate < 8_000 ||
    frame.sampleRate > 192_000 ||
    frame.frameMs !== profile.voice.frameMs
  ) {
    throw new Error("Invalid voice frame metadata");
  }
  const pcm16 = payloadToBytes(frame.pcm16);
  const expectedSamples = Math.max(
    320,
    Math.floor((frame.sampleRate * frame.frameMs) / 1000),
  );
  if (pcm16.byteLength !== expectedSamples * 2) {
    throw new Error("Invalid voice frame payload");
  }
  return pcm16;
}

function voiceError(stage: string, err: unknown): Error {
  const suffix = err instanceof Error ? err.message : String(err);
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
        return new Error(
          `${stage}: microphone access was denied by Android or browser site permissions`,
        );
      case "NotFoundError":
        return new Error(`${stage}: no usable microphone was found`);
      case "NotReadableError":
        return new Error(`${stage}: the microphone is busy or unavailable`);
      case "OverconstrainedError":
        return new Error(
          `${stage}: requested microphone settings are unsupported`,
        );
    }
  }
  return new Error(`${stage}: ${suffix}`);
}
