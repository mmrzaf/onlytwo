export interface FreshQueueShift<T> {
  value: T | null;
  dropped: number;
}

interface QueueItem<T> {
  value: T;
  queuedAt: number;
}

export class VoiceFreshnessQueue<T> {
  private items: Array<QueueItem<T>> = [];

  constructor(
    private maxFrames: number,
    private maxAgeMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.setLimits(maxFrames, maxAgeMs);
  }

  setLimits(maxFrames: number, maxAgeMs: number): number {
    this.maxFrames = Math.max(1, Math.floor(maxFrames));
    this.maxAgeMs = Math.max(1, Math.floor(maxAgeMs));
    return this.trimOverflow();
  }

  push(value: T): number {
    this.items.push({ value, queuedAt: this.now() });
    return this.trimOverflow();
  }

  shiftFresh(): FreshQueueShift<T> {
    const now = this.now();
    let dropped = 0;
    while (
      this.items.length > 0 &&
      now - this.items[0].queuedAt > this.maxAgeMs
    ) {
      this.items.shift();
      dropped += 1;
    }
    return { value: this.items.shift()?.value ?? null, dropped };
  }

  clear(): number {
    const count = this.items.length;
    this.items = [];
    return count;
  }

  get size(): number {
    return this.items.length;
  }

  private trimOverflow(): number {
    let dropped = 0;
    while (this.items.length > this.maxFrames) {
      this.items.shift();
      dropped += 1;
    }
    return dropped;
  }
}
