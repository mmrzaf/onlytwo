export class JitterBuffer<T extends { seq: number }> {
  private frames = new Map<number, T>();
  private expected: number | null = null;

  constructor(private maxFrames: number) {}

  push(frame: T): void {
    if (this.expected !== null && frame.seq < this.expected) return;
    this.frames.set(frame.seq, frame);
    while (this.frames.size > this.maxFrames) {
      const oldest = Math.min(...this.frames.keys());
      this.frames.delete(oldest);
      if (this.expected !== null && oldest === this.expected)
        this.expected += 1;
    }
  }

  pop(): T | null {
    if (this.frames.size === 0) return null;
    if (this.expected === null) this.expected = Math.min(...this.frames.keys());
    const exact = this.frames.get(this.expected);
    if (exact) {
      this.frames.delete(this.expected);
      this.expected += 1;
      return exact;
    }
    const oldest = Math.min(...this.frames.keys());
    if (oldest > this.expected) this.expected = oldest;
    const frame = this.frames.get(oldest) ?? null;
    if (frame) {
      this.frames.delete(oldest);
      this.expected = oldest + 1;
    }
    return frame;
  }

  clear(): void {
    this.frames.clear();
    this.expected = null;
  }

  get size(): number {
    return this.frames.size;
  }
}
