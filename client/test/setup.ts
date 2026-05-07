import { vi } from "vitest";

class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;

  postMessage(msg: any) {
    queueMicrotask(() => {
      if (msg.type === "GENERATE_IDENTITY") {
        this.onmessage?.(
          new MessageEvent("message", {
            data: {
              id: msg.id,
              result: new Uint8Array(32).fill(1),
            },
          }),
        );
      }
    });
  }
}

(globalThis as any).Worker = MockWorker;

Object.defineProperty(globalThis, "crypto", {
  value: {
    randomUUID: vi.fn(() => "test-id"),

    getRandomValues: (arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = i % 255;
      }

      return arr;
    },
  },
  configurable: true,
});
