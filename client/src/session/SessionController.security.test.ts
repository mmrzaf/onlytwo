import { beforeEach, describe, expect, it, vi } from "vitest";

const cryptoMock = vi.hoisted(() => ({
  decryptMessage: vi.fn(),
}));

vi.mock("../crypto/keys", () => ({
  cryptoClient: cryptoMock,
}));

import { SessionController } from "./SessionController";
import { MessageType } from "../transport/protocol";

class MockWs {
  handlers: any[] = [];

  onMessage(cb: any) {
    this.handlers.push(cb);
  }

  onStatusChange() {}
}

describe("SessionController counters", () => {
  beforeEach(() => {
    cryptoMock.decryptMessage.mockResolvedValue("hello");
  });

  it("processes repeated counters consistently", async () => {
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
      counter: 5n,
    });

    await ws.handlers[0]({
      type: MessageType.TEXT,
      payload: new Uint8Array([1]),
      nonce: new Uint8Array(12),
      counter: 5n,
    });

    expect(onMessageDecrypted).toHaveBeenCalledTimes(2);
  });

  it("processes rollback counters consistently", async () => {
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
      counter: 10n,
    });

    await ws.handlers[0]({
      type: MessageType.TEXT,
      payload: new Uint8Array([1]),
      nonce: new Uint8Array(12),
      counter: 2n,
    });

    expect(onMessageDecrypted).toHaveBeenCalledTimes(2);
  });
});
