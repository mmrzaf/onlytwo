import { describe, expect, it } from "vitest";
import { getProfile } from "../config/profiles";
import { profileHash } from "./negotiation";

describe("profileHash", () => {
  it("is stable and covers realtime policy fields", async () => {
    const profile = getProfile("balanced");
    const baseline = await profileHash(profile);
    expect(baseline).toMatch(/^[a-f0-9]{32}$/);
    expect(await profileHash(profile)).toBe(baseline);
    const changed = {
      ...profile,
      voice: { ...profile.voice, frameMs: profile.voice.frameMs + 1 },
    };
    expect(await profileHash(changed)).not.toBe(baseline);
  });
});
