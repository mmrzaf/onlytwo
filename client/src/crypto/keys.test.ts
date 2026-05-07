import { beforeEach, describe, expect, it, vi } from "vitest";
import { CryptoClient } from "./keys";

class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;

  constructor() {
    queueMicrotask(() => {
      this.onmessage?.(
        new MessageEvent("message", {
          data: {
            type: "READY",
          },
        }),
      );
    });
  }

  postMessage(msg: any) {
    queueMicrotask(() => {
      switch (msg.type) {
        case "GENERATE_IDENTITY":
          this.onmessage?.(
            new MessageEvent("message", {
              data: {
                id: msg.id,
                result: new Uint8Array(32).fill(1),
              },
            }),
          );
          break;

        case "ESTABLISH_SESSION":
          this.onmessage?.(
            new MessageEvent("message", {
              data: {
                id: msg.id,
                result: {
                  fingerprint: "AABBCCDD",
                },
              },
            }),
          );
          break;

        case "ENCRYPT_TEXT":
          this.onmessage?.(
            new MessageEvent("message", {
              data: {
                id: msg.id,
                result: {
                  ciphertext: new Uint8Array([1, 2, 3]),
                  nonce: new Uint8Array(12),
                  counter: 1n,
                },
              },
            }),
          );
          break;

        case "DECRYPT_TEXT":
          this.onmessage?.(
            new MessageEvent("message", {
              data: {
                id: msg.id,
                result: "hello",
              },
            }),
          );
          break;

        case "RESET":
          this.onmessage?.(
            new MessageEvent("message", {
              data: {
                id: msg.id,
                result: true,
              },
            }),
          );
          break;
      }
    });
  }
}

describe("CryptoClient", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", MockWorker as any);
  });

  it("generates identity", async () => {
    const client = new CryptoClient();

    const key = await client.generateIdentity();

    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it("establishes session", async () => {
    const client = new CryptoClient();

    const result = await client.establishSession(new Uint8Array(32).fill(9));

    expect(result.fingerprint).toBe("AABBCCDD");
  });

  it("encrypts messages", async () => {
    const client = new CryptoClient();

    const result = await client.encryptMessage("hello");

    expect(result.counter).toBe(1n);
  });

  it("decrypts messages", async () => {
    const client = new CryptoClient();

    const result = await client.decryptMessage(
      new Uint8Array([1]),
      new Uint8Array(12),
      1n,
    );

    expect(result).toBe("hello");
  });

  it("resets worker state", async () => {
    const client = new CryptoClient();

    await expect(client.reset()).resolves.toBe(true);
  });
});
