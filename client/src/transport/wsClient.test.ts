import { beforeEach, describe, expect, it, vi } from "vitest";
import { WsClient } from "./wsClient";

class MockWebSocket {
  static OPEN = 1;

  readyState = 1;
  binaryType = "";
  sent: any[] = [];

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    queueMicrotask(() => {
      this.onopen?.();
    });
  }

  send(data: any) {
    this.sent.push(data);
  }

  close() {
    this.onclose?.();
  }
}

describe("WsClient", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", MockWebSocket as any);
  });

  it("connects successfully", async () => {
    const ws = new WsClient();

    await ws.connect("abc");

    expect(ws.status).toBe("connected");
  });

  it("queues outbound handshake", async () => {
    const ws = new WsClient();

    await ws.connect("abc");

    ws.sendHandshake(new Uint8Array(32).fill(1));

    const socket = (ws as any).ws;

    expect(socket.sent.length).toBe(1);
  });

  it("disconnects cleanly", async () => {
    const ws = new WsClient();

    await ws.connect("abc");

    ws.disconnect();

    expect(ws.status).toBe("disconnected");
  });
});
