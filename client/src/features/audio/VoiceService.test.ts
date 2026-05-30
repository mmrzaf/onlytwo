import { describe, expect, it } from "vitest";
import { getProfile } from "../../config/profiles";
import { bytesToPayload } from "../../protocol/appMessages";
import { decodeInboundVoiceFrame } from "./VoiceService";

describe("decodeInboundVoiceFrame", () => {
  const profile = getProfile("balanced");
  const sampleRate = 48_000;
  const expectedBytes =
    Math.floor((sampleRate * profile.voice.frameMs) / 1000) * 2;
  const valid = {
    streamId: "voice",
    seq: 1,
    sentAt: 1,
    sampleRate,
    frameMs: profile.voice.frameMs,
    pcm16: bytesToPayload(new Uint8Array(expectedBytes)),
  };

  it("accepts a correctly sized canonical frame", () => {
    expect(decodeInboundVoiceFrame(valid, profile)).toHaveLength(expectedBytes);
  });

  it("rejects malformed metadata and payload sizes", () => {
    expect(() =>
      decodeInboundVoiceFrame({ ...valid, streamId: "wrong" }, profile),
    ).toThrow("metadata");
    expect(() =>
      decodeInboundVoiceFrame(
        { ...valid, frameMs: valid.frameMs + 1 },
        profile,
      ),
    ).toThrow("metadata");
    expect(() =>
      decodeInboundVoiceFrame({ ...valid, pcm16: "AA" }, profile),
    ).toThrow("payload");
  });
});
