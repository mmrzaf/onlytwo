import { afterEach, describe, expect, it, vi } from "vitest";
import { getProfile } from "../config/profiles";
import { WebSocketConnection } from "./WebSocketConnection";

afterEach(() => vi.unstubAllGlobals());

describe("WebSocketConnection", () => {
  it("rejects when the relay closes before the websocket opens", async () => {
    class ClosingWebSocket {
      static readonly OPEN = 1;
      readonly readyState = 0;
      readonly bufferedAmount = 0;
      binaryType = "";
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null =
        null;
      onmessage: ((event: MessageEvent) => void) | null = null;

      constructor() {
        queueMicrotask(() =>
          this.onclose?.({ code: 1008, reason: "session unavailable" }),
        );
      }
      close(): void {}
      send(): void {}
    }

    vi.stubGlobal("WebSocket", ClosingWebSocket);
    const connection = new WebSocketConnection(getProfile("balanced"));
    await expect(connection.connect("ABCD-2345")).rejects.toThrow(
      "session unavailable",
    );
  });
});
