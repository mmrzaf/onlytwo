import { beforeEach, describe, expect, it, vi } from "vitest";

const cryptoMock = vi.hoisted(() => ({
  reset: vi.fn(),
  generateIdentity: vi.fn(),
  establishSession: vi.fn(),
  encryptMessage: vi.fn(),
  decryptMessage: vi.fn(),
  encryptBinary: vi.fn(),
  decryptBinary: vi.fn(),
}));

vi.mock("../crypto/keys", () => ({
  cryptoClient: cryptoMock,
}));

import { SessionController } from "./SessionController";
import { MessageType } from "../transport/protocol";

class MockWs {
  handlers: any[] = [];

  connect = vi.fn(async () => {});
  disconnect = vi.fn();
  sendHandshake = vi.fn();

  onMessage(cb: any) {
    this.handlers.push(cb);
  }

  onStatusChange() {}
}

describe("SessionController handshake", () => {
  beforeEach(() => {
    cryptoMock.generateIdentity.mockResolvedValue(new Uint8Array(32).fill(1));

    cryptoMock.establishSession.mockResolvedValue({
      fingerprint: "ABCD1234",
    });
  });

  it("completes handshake", async () => {
    const ws = new MockWs();

    const state: any = {
      handshakeComplete: false,
    };

    new SessionController(ws as any, state, {
      onPhaseChange: vi.fn(),
      onError: vi.fn(),
      onFingerprintAvailable: vi.fn(),
      onMessageDecrypted: vi.fn(),
      onFileReceived: vi.fn(),
    });

    await ws.handlers[0]({
      type: MessageType.HANDSHAKE,
      payload: new Uint8Array(32).fill(9),
    });

    expect(cryptoMock.establishSession).toHaveBeenCalled();
  });
});
