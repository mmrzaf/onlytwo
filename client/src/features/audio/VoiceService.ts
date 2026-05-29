import type { TransportProfile } from "../../config/profiles";
import { bytesToPayload, payloadToBytes } from "../../protocol/appMessages";
import { JitterBuffer } from "./JitterBuffer";
import { floatToPcm16, pcm16ToFloat } from "./pcm";

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
  private seq = 0;
  private muted = false;
  private captureBuffer: Float32Array[] = [];
  private captureSamples = 0;
  private jitter: JitterBuffer<VoiceFrame>;
  private playbackTimer: ReturnType<typeof setInterval> | null = null;
  private nextPlaybackTime = 0;
  private streamId = "voice";

  constructor(private profile: TransportProfile) {
    this.jitter = new JitterBuffer<VoiceFrame>(profile.voice.jitterMaxFrames);
  }

  setProfile(profile: TransportProfile): void {
    this.profile = profile;
    this.jitter = new JitterBuffer<VoiceFrame>(profile.voice.jitterMaxFrames);
  }

  get active(): boolean { return !!this.stream; }
  get isMuted(): boolean { return this.muted; }
  get actualSampleRate(): number { return this.inputCtx?.sampleRate ?? 48_000; }

  async start(onFrame: (frame: VoiceFrame) => void): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    this.inputCtx = new AudioContext();
    this.outputCtx = new AudioContext();
    await this.inputCtx.resume();
    await this.outputCtx.resume();

    const workletUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: "text/javascript" }));
    try { await this.inputCtx.audioWorklet.addModule(workletUrl); }
    finally { URL.revokeObjectURL(workletUrl); }

    this.captureNode = new AudioWorkletNode(this.inputCtx, "onlytwo-capture");
    this.sourceNode = this.inputCtx.createMediaStreamSource(this.stream);
    this.sourceNode.connect(this.captureNode);
    this.captureNode.connect(this.inputCtx.destination);

    const sampleRate = this.inputCtx.sampleRate;
    const samplesPerFrame = Math.max(320, Math.floor(sampleRate * this.profile.voice.frameMs / 1000));
    this.captureNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!this.stream || this.muted) return;
      this.captureBuffer.push(event.data);
      this.captureSamples += event.data.length;
      while (this.captureSamples >= samplesPerFrame) {
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
        onFrame({ streamId: this.streamId, seq: ++this.seq, sentAt: Date.now(), sampleRate, frameMs: this.profile.voice.frameMs, pcm16: bytesToPayload(floatToPcm16(frame)) });
      }
    };
  }

  stop(): void {
    this.muted = false;
    this.captureBuffer = [];
    this.captureSamples = 0;
    this.jitter.clear();
    if (this.playbackTimer !== null) clearInterval(this.playbackTimer);
    this.playbackTimer = null;
    if (this.captureNode) this.captureNode.disconnect();
    if (this.sourceNode) this.sourceNode.disconnect();
    this.captureNode = null;
    this.sourceNode = null;
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
    void this.inputCtx?.close().catch(() => undefined);
    void this.outputCtx?.close().catch(() => undefined);
    this.inputCtx = null;
    this.outputCtx = null;
  }

  setMuted(value: boolean): void { this.muted = value; }

  async play(frame: VoiceFrame): Promise<void> {
    if (!this.outputCtx) this.outputCtx = new AudioContext();
    if (this.outputCtx.state !== "running") await this.outputCtx.resume();
    this.jitter.push(frame);
    if (this.playbackTimer === null) {
      this.nextPlaybackTime = this.outputCtx.currentTime + this.profile.voice.jitterTargetMs / 1000;
      this.playbackTimer = setInterval(() => this.playNext(), Math.max(10, this.profile.voice.frameMs / 2));
    }
  }

  private playNext(): void {
    if (!this.outputCtx) return;
    const frame = this.jitter.pop();
    if (!frame) return;
    const samples = pcm16ToFloat(payloadToBytes(frame.pcm16));
    const buffer = this.outputCtx.createBuffer(1, samples.length, frame.sampleRate || this.outputCtx.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.outputCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outputCtx.destination);
    const startAt = Math.max(this.outputCtx.currentTime + 0.01, this.nextPlaybackTime);
    source.start(startAt);
    this.nextPlaybackTime = startAt + buffer.duration;
    if (this.nextPlaybackTime - this.outputCtx.currentTime > 0.8) this.nextPlaybackTime = this.outputCtx.currentTime + 0.2;
  }
}
