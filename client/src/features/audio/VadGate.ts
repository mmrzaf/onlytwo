export interface VadConfig {
  enabled: boolean;
  startDb: number;
  stopDb: number;
  preRollFrames: number;
  hangoverFrames: number;
  minSpeechFrames: number;
}

export interface VadDecision {
  send: boolean;
  started: boolean;
  stopped: boolean;
  levelDb: number;
  frames: Float32Array[];
}

export class VadGate {
  private speaking = false;
  private aboveStartFrames = 0;
  private hangoverRemaining = 0;
  private preRoll: Float32Array[] = [];

  constructor(private config: VadConfig) {}

  setConfig(config: VadConfig): void {
    this.config = config;
    this.reset();
  }

  reset(): void {
    this.speaking = false;
    this.aboveStartFrames = 0;
    this.hangoverRemaining = 0;
    this.preRoll = [];
  }

  process(frame: Float32Array): VadDecision {
    const levelDb = rmsDb(frame);

    if (!this.config.enabled) {
      return {
        send: true,
        started: false,
        stopped: false,
        levelDb,
        frames: [frame],
      };
    }

    if (!this.speaking) {
      this.preRoll.push(frame);
      while (this.preRoll.length > this.config.preRollFrames)
        this.preRoll.shift();

      if (levelDb >= this.config.startDb) {
        this.aboveStartFrames += 1;
      } else {
        this.aboveStartFrames = 0;
      }

      if (this.aboveStartFrames >= this.config.minSpeechFrames) {
        const frames = [...this.preRoll];
        this.preRoll = [];
        this.speaking = true;
        this.hangoverRemaining = this.config.hangoverFrames;
        this.aboveStartFrames = 0;
        return { send: true, started: true, stopped: false, levelDb, frames };
      }

      return {
        send: false,
        started: false,
        stopped: false,
        levelDb,
        frames: [],
      };
    }

    if (levelDb >= this.config.stopDb) {
      this.hangoverRemaining = this.config.hangoverFrames;
      return {
        send: true,
        started: false,
        stopped: false,
        levelDb,
        frames: [frame],
      };
    }

    if (this.hangoverRemaining > 0) {
      this.hangoverRemaining -= 1;
      return {
        send: true,
        started: false,
        stopped: false,
        levelDb,
        frames: [frame],
      };
    }

    this.speaking = false;
    this.preRoll = [frame].slice(-this.config.preRollFrames);
    return { send: false, started: false, stopped: true, levelDb, frames: [] };
  }
}

export function rmsDb(frame: Float32Array): number {
  if (frame.length === 0) return -Infinity;

  let sum = 0;
  for (const sample of frame) {
    sum += sample * sample;
  }

  const rms = Math.sqrt(sum / frame.length);
  return 20 * Math.log10(rms + 1e-8);
}

export function framesFromMs(durationMs: number, frameMs: number): number {
  if (durationMs <= 0 || frameMs <= 0) return 0;
  return Math.max(1, Math.ceil(durationMs / frameMs));
}
