import { beforeEach, describe, expect, it, vi } from "vitest";
import { WsClient } from "./wsClient";

class MockSocket {
  static OPEN = 1;

  readyState = 1;

  onopen: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  constructor() {
    queueMicrotask(() => {
      this.onopen?.();
    });
  }

  send() {}

  triggerError() {
    this.onerror?.(new Event("error"));
  }
}

describe("WsClient error handling", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", MockSocket as any);
  });

  it("survives socket errors", async () => {
    const client = new WsClient();

    await client.connect("room");

    const socket = (client as any).ws as MockSocket;

    expect(() => {
      socket.triggerError();
    }).not.toThrow();
  });
});
