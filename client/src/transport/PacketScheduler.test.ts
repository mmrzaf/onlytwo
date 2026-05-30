import { describe, expect, it } from "vitest";
import { getProfile } from "../config/profiles";
import { PacketScheduler } from "./PacketScheduler";

describe("PacketScheduler", () => {
  it("clears every encrypted lane before a fresh crypto epoch", () => {
    const scheduler = new PacketScheduler(getProfile("balanced"));
    for (const lane of ["control", "text", "file", "voice"] as const) {
      expect(scheduler.enqueue({ lane, bytes: new Uint8Array(32) }).ok).toBe(
        true,
      );
    }
    expect(scheduler.snapshot().packets).toBe(4);
    scheduler.clear();
    expect(scheduler.snapshot()).toEqual({
      packets: 0,
      bytes: 0,
      lanePackets: { control: 0, text: 0, file: 0, voice: 0 },
      laneBytes: { control: 0, text: 0, file: 0, voice: 0 },
    });
  });
});
