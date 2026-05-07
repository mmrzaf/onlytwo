import { describe, expect, it, vi } from "vitest";

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

describe("SessionController invalid payloads", () => {
  it("survives malformed packets", async () => {
    const ws = new MockWs();

    new SessionController(
      ws as any,
      {
        phase: "chatting",
      } as any,
      {
        onPhaseChange: vi.fn(),
        onError: vi.fn(),
        onFingerprintAvailable: vi.fn(),
        onMessageDecrypted: vi.fn(),
        onFileReceived: vi.fn(),
      },
    );

    await expect(
      ws.handlers[0]({
        type: MessageType.TEXT,
        payload: null,
      }),
    ).resolves.not.toThrow();
  });

  it("survives decrypt failures", async () => {
    const ws = new MockWs();

    cryptoMock.decryptMessage.mockRejectedValue(new Error("decrypt failed"));

    new SessionController(
      ws as any,
      {
        phase: "chatting",
      } as any,
      {
        onPhaseChange: vi.fn(),
        onError: vi.fn(),
        onFingerprintAvailable: vi.fn(),
        onMessageDecrypted: vi.fn(),
        onFileReceived: vi.fn(),
      },
    );

    await expect(
      ws.handlers[0]({
        type: MessageType.TEXT,
        payload: new Uint8Array([1]),
        nonce: new Uint8Array(12),
        counter: 1n,
      }),
    ).resolves.not.toThrow();
  });
});
