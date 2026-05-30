import { describe, expect, it } from "vitest";
import {
  decodeRelayEvent,
  encodeSessionEndCommand,
  isRelayControlFrame,
} from "./relayControl";

describe("relay control", () => {
  it("encodes the session end command", () => {
    const bytes = encodeSessionEndCommand();
    expect([...bytes]).toEqual([0x4f, 0x52, 1, 4]);
    expect(isRelayControlFrame(bytes.buffer)).toBe(true);
    expect(decodeRelayEvent(bytes.buffer)).toBeNull();
  });

  it("decodes relay events", () => {
    expect(decodeRelayEvent(Uint8Array.of(0x4f, 0x52, 1, 1).buffer)).toEqual({
      kind: "peer.present",
    });
    expect(decodeRelayEvent(Uint8Array.of(0x4f, 0x52, 1, 2).buffer)).toEqual({
      kind: "peer.disconnected",
    });
    expect(decodeRelayEvent(Uint8Array.of(0x4f, 0x52, 1, 3).buffer)).toEqual({
      kind: "peer.rejoined",
    });
    expect(decodeRelayEvent(Uint8Array.of(0x4f, 0x52, 1, 5).buffer)).toEqual({
      kind: "session.ended",
    });
  });

  it("ignores ordinary encrypted envelopes", () => {
    expect(isRelayControlFrame(Uint8Array.of(0x4f, 0x54, 1, 1).buffer)).toBe(
      false,
    );
  });
});
