import { describe, expect, it } from "vitest";
import { PROFILES } from "./profiles";

describe("transport profiles", () => {
  it("keeps beta file limits conservative and memory bounded", () => {
    expect(PROFILES.balanced.files.maxFileBytes).toBeLessThanOrEqual(
      50 * 1024 * 1024,
    );
    expect(PROFILES.balanced.files.maxMemoryReceiveBytes).toBeLessThanOrEqual(
      PROFILES.balanced.files.maxFileBytes,
    );
    expect(PROFILES.maximum_privacy.files.maxFileBytes).toBeLessThanOrEqual(
      25 * 1024 * 1024,
    );
  });

  it("defines browser websocket backpressure thresholds", () => {
    for (const profile of Object.values(PROFILES)) {
      expect(profile.outbox.maxBufferedAmountBytes).toBeGreaterThan(
        profile.outbox.resumeBufferedAmountBytes,
      );
      expect(profile.outbox.resumeBufferedAmountBytes).toBeGreaterThan(0);
    }
  });

  it("uses VAD only outside maximum privacy voice mode", () => {
    expect(PROFILES.balanced.voice.mode).toBe("efficient");
    expect(PROFILES.balanced.voice.vadEnabled).toBe(true);
    expect(PROFILES.maximum_privacy.voice.mode).toBe("maximum_privacy");
    expect(PROFILES.maximum_privacy.voice.vadEnabled).toBe(false);
  });
});
