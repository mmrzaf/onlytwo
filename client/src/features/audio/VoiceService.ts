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
  private jitter: JitterBuffer<VoiceFrame>;
  private playbackTimer: ReturnType<typeof setInterval> | null = null;
  private nextPlaybackTime = 0;
  private streamId = "voice";
  private vad: VadGate;

  constructor(private profile: TransportProfile) {
    this.jitter = new JitterBuffer<VoiceFrame>(profile.voice.jitterMaxFrames);
    this.vad = new VadGate(this.vadConfig(profile));
  }

  setProfile(profile: TransportProfile): void {
    this.profile = profile;
    this.jitter = new JitterBuffer<VoiceFrame>(profile.voice.jitterMaxFrames);
    this.vad.setConfig(this.vadConfig(profile));
  }

  get active(): boolean { return !!this.stream; }
  get isMuted(): boolean { return this.muted; }
  get actualSampleRate(): number { return this.inputCtx?.sampleRate ?? 48_000; }

  async start(onFrame: (frame: VoiceFrame) => void): Promise<void> {
    if (this.stream) return;
    if (!this.profile.voice.enabled) throw new Error("Voice is disabled in this profile");

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    this.inputCtx = new AudioContext();
    this.outputCtx = new AudioContext();
    await this.inputCtx.resume();
    await this.outputCtx.resume();

    const workletUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: "text/javascript" }));
    try { await this.inputCtx.audioWorklet.addModule(workletUrl); }
    finally { URL.revokeObjectURL(workletUrl); }

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
    const samplesPerFrame = Math.max(320, Math.floor(sampleRate * this.profile.voice.frameMs / 1000));

    this.captureNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!this.stream || this.muted) return;

      this.captureBuffer.push(event.data);
      this.captureSamples += event.data.length;

      while (this.captureSamples >= samplesPerFrame) {
        const frame = this.readFrame(samplesPerFrame);
        const framesToSend = this.framesAllowedByVoiceMode(frame);

        for (const outboundFrame of framesToSend) {
          onFrame({
            streamId: this.streamId,
            seq: ++this.seq,
            sentAt: Date.now(),
            sampleRate,
            frameMs: this.profile.voice.frameMs,
            pcm16: bytesToPayload(floatToPcm16(outboundFrame))
          });
        }
      }
    };
  }

  stop(): void {
    this.muted = false;
    this.captureBuffer = [];
    this.captureSamples = 0;
    this.vad.reset();
    this.jitter.clear();

    if (this.playbackTimer !== null) clearInterval(this.playbackTimer);
    this.playbackTimer = null;

    try { this.captureNode?.disconnect(); } catch {}
    try { this.sourceNode?.disconnect(); } catch {}
    try { this.zeroGain?.disconnect(); } catch {}

    this.captureNode = null;
    this.sourceNode = null;
    this.zeroGain = null;

    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;

    void this.inputCtx?.close().catch(() => undefined);
    void this.outputCtx?.close().catch(() => undefined);
    this.inputCtx = null;
    this.outputCtx = null;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.captureBuffer = [];
    this.captureSamples = 0;
    this.vad.reset();
  }

  async play(frame: VoiceFrame): Promise<void> {
    if (!this.outputCtx) {
      this.outputCtx = new AudioContext();
      await this.outputCtx.resume();
    }

    this.jitter.push(frame);

    if (this.playbackTimer === null) {
      this.nextPlaybackTime = this.outputCtx.currentTime + this.profile.voice.jitterTargetMs / 1000;
      this.playbackTimer = setInterval(() => this.flushPlayback(), this.profile.voice.frameMs);
    }
  }

  private flushPlayback(): void {
    if (!this.outputCtx) return;

    const frame = this.jitter.pop();
    if (!frame) return;

    const floats = pcm16ToFloat(payloadToBytes(frame.pcm16));
    const buffer = this.outputCtx.createBuffer(1, floats.length, frame.sampleRate);
    buffer.copyToChannel(floats, 0);

    const source = this.outputCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outputCtx.destination);

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
    if (this.profile.voice.mode === "maximum_privacy") {
      return [frame];
    }

    const decision = this.vad.process(frame);
    return decision.send ? decision.frames : [];
  }

  private vadConfig(profile: TransportProfile) {
    return {
      enabled: profile.voice.vadEnabled && profile.voice.mode === "efficient",
      startDb: profile.voice.vadStartDb,
      stopDb: profile.voice.vadStopDb,
      preRollFrames: framesFromMs(profile.voice.vadPreRollMs, profile.voice.frameMs),
      hangoverFrames: framesFromMs(profile.voice.vadHangoverMs, profile.voice.frameMs),
      minSpeechFrames: framesFromMs(profile.voice.vadMinSpeechMs, profile.voice.frameMs)
    };
  }
}
