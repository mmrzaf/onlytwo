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

class MockWs {
  handlers: any[] = [];

  connect = vi.fn(async () => {});
  disconnect = vi.fn();
  sendHandshake = vi.fn();
  sendChat = vi.fn();
  sendMedia = vi.fn();

  onMessage(cb: any) {
    this.handlers.push(cb);
  }

  onStatusChange() {}
}

describe("SessionController", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    cryptoMock.reset.mockResolvedValue(undefined);

    cryptoMock.generateIdentity.mockResolvedValue(new Uint8Array(32).fill(1));

    cryptoMock.establishSession.mockResolvedValue({
      fingerprint: "ABCD1234",
    });
  });

  it("starts session", async () => {
    const ws = new MockWs();

    const ctrl = new SessionController(
      ws as any,
      {
        phase: "disconnected",
      } as any,
      {
        onPhaseChange: vi.fn(),
        onError: vi.fn(),
        onFingerprintAvailable: vi.fn(),
        onMessageDecrypted: vi.fn(),
        onFileReceived: vi.fn(),
      },
    );

    await ctrl.startSession("room");

    expect(ws.connect).toHaveBeenCalledWith("room");
    expect(ws.sendHandshake).toHaveBeenCalled();
  });

  it("sends encrypted message", async () => {
    const ws = new MockWs();

    cryptoMock.encryptMessage.mockResolvedValue({
      ciphertext: new Uint8Array([1]),
      nonce: new Uint8Array(12),
      counter: 1n,
    });

    const ctrl = new SessionController(
      ws as any,
      {
        phase: "chatting",
        handshakeComplete: true,
      } as any,
      {
        onPhaseChange: vi.fn(),
        onError: vi.fn(),
        onFingerprintAvailable: vi.fn(),
        onMessageDecrypted: vi.fn(),
        onFileReceived: vi.fn(),
      },
    );

    await ctrl.sendMessage("hello");

    expect(ws.sendChat).toHaveBeenCalled();
  });
});
