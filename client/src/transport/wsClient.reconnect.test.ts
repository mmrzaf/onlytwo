import { beforeEach, describe, expect, it, vi } from "vitest";
import { WsClient } from "./wsClient";

const sockets: MockSocket[] = [];

class MockSocket {
  static OPEN = 1;

  readyState = 1;
  binaryType = "";

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    sockets.push(this);

    queueMicrotask(() => {
      this.onopen?.();
    });
  }

  send() {}

  close() {
    this.onclose?.();
  }

  simulateDrop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("WsClient reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();

    sockets.length = 0;

    vi.stubGlobal("WebSocket", MockSocket as any);
  });

  it("transitions to reconnecting", async () => {
    const client = new WsClient();

    await client.connect("room");

    sockets[0].simulateDrop();

    expect(client.status).toBe("reconnecting");
  });

  it("reconnects automatically", async () => {
    const client = new WsClient();

    await client.connect("room");

    sockets[0].simulateDrop();

    vi.advanceTimersByTime(2000);

    await Promise.resolve();

    expect(sockets.length).toBeGreaterThan(1);
  });

  it("stops reconnect after disconnect", async () => {
    const client = new WsClient();

    await client.connect("room");

    client.disconnect();

    vi.advanceTimersByTime(60000);

    expect(client.status).toBe("disconnected");
  });
});
