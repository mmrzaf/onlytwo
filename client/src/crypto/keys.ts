const REQUEST_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 10_000;

export class CryptoClient {
  private worker: Worker;
  private pendingRequests: Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  > = new Map();
  private isReady = false;
  private readyQueue: Array<() => void> = [];

  constructor() {
    this.worker = new Worker(new URL("./cryptoWorker.ts", import.meta.url), {
      type: "module",
    });

    this.worker.onmessage = (e: MessageEvent) => {
      const { type, id, result, error } = e.data as {
        type?: string;
        id?: string;
        result?: unknown;
        error?: string;
      };

      if (type === "READY") {
        this.isReady = true;
        this.readyQueue.forEach((cb) => cb());
        this.readyQueue = [];
        return;
      }

      if (!id) return;
      const req = this.pendingRequests.get(id);
      if (!req) return;
      this.pendingRequests.delete(id);

      if (error) req.reject(new Error(error));
      else req.resolve(result);
    };

    this.worker.onerror = (e: ErrorEvent) => {
      console.error("[CryptoClient] Worker error:", e.message);
      const err = new Error(`Crypto worker crashed: ${e.message}`);
      for (const req of this.pendingRequests.values()) req.reject(err);
      this.pendingRequests.clear();
    };
  }

  private waitForReady(): Promise<void> {
    if (this.isReady) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Crypto worker did not become ready in time")),
        READY_TIMEOUT_MS,
      );
      this.readyQueue.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async request<T>(type: string, payload?: unknown): Promise<T> {
    await this.waitForReady();

    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Crypto operation timed out: ${type}`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.worker.postMessage({ type, payload, id });
    });
  }

  async generateIdentity(): Promise<Uint8Array> {
    return this.request<Uint8Array>("GENERATE_IDENTITY");
  }

  async establishSession(
    peerPublicKey: Uint8Array,
  ): Promise<{ fingerprint: string }> {
    return this.request<{ fingerprint: string }>(
      "ESTABLISH_SESSION",
      peerPublicKey,
    );
  }

  async encryptMessage(
    text: string,
  ): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array; counter: bigint }> {
    return this.request("ENCRYPT_TEXT", text);
  }

  async decryptMessage(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    counter: bigint,
  ): Promise<string> {
    return this.request("DECRYPT_TEXT", { ciphertext, nonce, counter });
  }

  async encryptBinary(
    data: Uint8Array,
  ): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array; counter: bigint }> {
    return this.request("ENCRYPT_BINARY", data);
  }

  async decryptBinary(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    counter: bigint,
  ): Promise<Uint8Array> {
    return this.request("DECRYPT_BINARY", { ciphertext, nonce, counter });
  }

  async reset(): Promise<void> {
    return this.request("RESET");
  }
}

export const cryptoClient = new CryptoClient();
