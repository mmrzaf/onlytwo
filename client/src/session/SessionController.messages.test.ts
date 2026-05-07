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

  onMessage(cb: any) {
    this.handlers.push(cb);
  }

  onStatusChange() {}
}

describe("SessionController messages", () => {
  beforeEach(() => {
    cryptoMock.decryptMessage.mockResolvedValue("hello");
  });

  it("decrypts incoming text", async () => {
    const ws = new MockWs();

    const onMessageDecrypted = vi.fn();

    new SessionController(
      ws as any,
      {
        phase: "chatting",
        handshakeComplete: true,
      } as any,
      {
        onPhaseChange: vi.fn(),
        onError: vi.fn(),
        onFingerprintAvailable: vi.fn(),
        onMessageDecrypted,
        onFileReceived: vi.fn(),
      },
    );

    await ws.handlers[0]({
      type: MessageType.TEXT,
      payload: new Uint8Array([1]),
      nonce: new Uint8Array(12),
      counter: 1n,
    });

    expect(onMessageDecrypted).toHaveBeenCalledWith("hello");
  });
});
