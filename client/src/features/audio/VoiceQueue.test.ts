import { describe, expect, it } from "vitest";
import { VoiceFreshnessQueue } from "./VoiceQueue";

describe("VoiceFreshnessQueue", () => {
  it("keeps the newest frames when full", () => {
    let now = 0;
    const queue = new VoiceFreshnessQueue<number>(2, 100, () => now);
    expect(queue.push(1)).toBe(0);
    expect(queue.push(2)).toBe(0);
    expect(queue.push(3)).toBe(1);
    expect(queue.shiftFresh().value).toBe(2);
    expect(queue.shiftFresh().value).toBe(3);
  });

  it("drops stale frames", () => {
    let now = 0;
    const queue = new VoiceFreshnessQueue<number>(4, 100, () => now);
    queue.push(1);
    now = 101;
    queue.push(2);
    expect(queue.shiftFresh()).toEqual({ value: 2, dropped: 1 });
  });
});
