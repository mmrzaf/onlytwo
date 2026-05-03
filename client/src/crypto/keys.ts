export class CryptoClient {
  private worker: Worker;
  private pendingRequests: Map<
    string,
    { resolve: Function; reject: Function }
  > = new Map();
  private isReady = false;
  private readyQueue: Function[] = [];

  constructor() {
    this.worker = new Worker(new URL("./cryptoWorker.ts", import.meta.url), {
      type: "module",
    });

    this.worker.onmessage = (e) => {
      const { type, id, result, error } = e.data;
      if (type === "READY") {
        this.isReady = true;
        this.readyQueue.forEach((cb) => cb());
        this.readyQueue = [];
        return;
      }

      const req = this.pendingRequests.get(id);
      if (req) {
        if (error) req.reject(new Error(error));
        else req.resolve(result);
        this.pendingRequests.delete(id);
      }
    };
  }

  private async request(type: string, payload?: any): Promise<any> {
    if (!this.isReady) await new Promise((res) => this.readyQueue.push(res));

    const id = Math.random().toString(36).substring(2);
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.worker.postMessage({ type, payload, id });
    });
  }

  async generateIdentity(): Promise<Uint8Array> {
    return this.request("GENERATE_IDENTITY");
  }

  async establishSession(
    peerPublicKey: Uint8Array,
  ): Promise<{ fingerprint: string }> {
    return this.request("ESTABLISH_SESSION", peerPublicKey);
  }

  // Returns exact components needed for Blueprint Section 8
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
