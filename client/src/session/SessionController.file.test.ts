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
  connect = vi.fn(async () => {});
  disconnect = vi.fn();

  sendHandshake = vi.fn();
  sendChat = vi.fn();
  sendMedia = vi.fn();

  onMessage() {}
  onStatusChange() {}
}

describe("SessionController file sending", () => {
  beforeEach(() => {
    cryptoMock.encryptMessage.mockResolvedValue({
      ciphertext: new Uint8Array([1]),
      nonce: new Uint8Array(12),
      counter: 1n,
    });

    cryptoMock.encryptBinary.mockResolvedValue({
      ciphertext: new Uint8Array([2]),
      nonce: new Uint8Array(12),
      counter: 2n,
    });
  });

  it("sends file metadata and chunks", async () => {
    const ws = new MockWs();

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

    const file = new File([new Uint8Array([1, 2, 3])], "secret.bin", {
      type: "application/octet-stream",
    });

    await ctrl.sendFile(file);

    expect(ws.sendChat).toHaveBeenCalled();
    expect(ws.sendMedia).toHaveBeenCalled();
  });
});
