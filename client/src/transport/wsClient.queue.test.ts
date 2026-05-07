import { beforeEach, describe, expect, it, vi } from "vitest";
import { WsClient } from "./wsClient";

const sent: any[] = [];

class MockSocket {
  static OPEN = 1;

  readyState = 1;
  binaryType = "";

  onopen: (() => void) | null = null;

  constructor() {
    queueMicrotask(() => {
      this.onopen?.();
    });
  }

  send(data: any) {
    sent.push(data);
  }

  close() {}
}

describe("WsClient sending", () => {
  beforeEach(() => {
    sent.length = 0;

    vi.stubGlobal("WebSocket", MockSocket as any);
  });

  it("sends handshake packets", async () => {
    const client = new WsClient();

    await client.connect("room");

    client.sendHandshake(new Uint8Array(32));

    expect(sent.length).toBe(1);
  });

  it("sends chat packets", async () => {
    const client = new WsClient();

    await client.connect("room");

    client.sendChat(new Uint8Array([1]), new Uint8Array(12), 1n);

    expect(sent.length).toBe(1);
  });
});
