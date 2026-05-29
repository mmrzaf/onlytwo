import { describe, expect, it } from "vitest";
import { VadGate, framesFromMs, rmsDb } from "./VadGate";

function frame(value: number, length = 160): Float32Array {
  return new Float32Array(length).fill(value);
}

describe("VadGate", () => {
  it("computes useful RMS dB levels", () => {
    expect(rmsDb(frame(0))).toBeLessThan(-120);
    expect(rmsDb(frame(0.1))).toBeGreaterThan(-21);
    expect(rmsDb(frame(0.1))).toBeLessThan(-19);
  });

  it("does not send silence in efficient mode", () => {
    const vad = new VadGate({
      enabled: true,
      startDb: -45,
      stopDb: -52,
      preRollFrames: 2,
      hangoverFrames: 2,
      minSpeechFrames: 1
    });

    const decision = vad.process(frame(0.0001));
    expect(decision.send).toBe(false);
    expect(decision.frames).toHaveLength(0);
  });

  it("sends pre-roll when speech starts", () => {
    const vad = new VadGate({
      enabled: true,
      startDb: -45,
      stopDb: -52,
      preRollFrames: 2,
      hangoverFrames: 2,
      minSpeechFrames: 1
    });

    vad.process(frame(0.0001));
    vad.process(frame(0.0002));

    const decision = vad.process(frame(0.1));

    expect(decision.started).toBe(true);
    expect(decision.send).toBe(true);
    expect(decision.frames).toHaveLength(2);
  });

  it("keeps sending during hangover to avoid chopping word endings", () => {
    const vad = new VadGate({
      enabled: true,
      startDb: -45,
      stopDb: -52,
      preRollFrames: 0,
      hangoverFrames: 2,
      minSpeechFrames: 1
    });

    expect(vad.process(frame(0.1)).send).toBe(true);
    expect(vad.process(frame(0.0001)).send).toBe(true);
    expect(vad.process(frame(0.0001)).send).toBe(true);

    const stopped = vad.process(frame(0.0001));
    expect(stopped.send).toBe(false);
    expect(stopped.stopped).toBe(true);
  });

  it("can be disabled for constant cadence privacy mode", () => {
    const vad = new VadGate({
      enabled: false,
      startDb: -45,
      stopDb: -52,
      preRollFrames: 2,
      hangoverFrames: 2,
      minSpeechFrames: 1
    });

    const decision = vad.process(frame(0));
    expect(decision.send).toBe(true);
    expect(decision.frames).toHaveLength(1);
  });

  it("converts millisecond windows into frame counts", () => {
    expect(framesFromMs(120, 40)).toBe(3);
    expect(framesFromMs(1, 40)).toBe(1);
    expect(framesFromMs(0, 40)).toBe(0);
  });
});
