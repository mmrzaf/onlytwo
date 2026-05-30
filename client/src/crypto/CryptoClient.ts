import type { TransportProfile } from "../config/profiles";
import type { AadContext } from "../protocol/envelope";

const REQUEST_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 10_000;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface EncryptedPayload {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  counter: bigint;
}

export class CryptoClient {
  private worker: Worker;
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private pending = new Map<string, PendingRequest>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor() {
    this.worker = new Worker(new URL("./cryptoWorker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as {
        type?: string;
        id?: string;
        result?: unknown;
        error?: string;
      };
      if (msg.type === "READY") {
        this.ready = true;
        for (const waiter of this.readyWaiters.splice(0)) waiter();
        return;
      }
      if (!msg.id) return;
      const req = this.pending.get(msg.id);
      if (!req) return;
      clearTimeout(req.timer);
      this.pending.delete(msg.id);
      if (msg.error) req.reject(new Error(msg.error));
      else req.resolve(msg.result);
    };
    this.worker.onerror = (event) => {
      const err = new Error(`Crypto worker crashed: ${event.message}`);
      for (const req of this.pending.values()) {
        clearTimeout(req.timer);
        req.reject(err);
      }
      this.pending.clear();
    };
  }

  configure(profile: TransportProfile): Promise<boolean> {
    return this.serialRequest("CONFIGURE", {
      paddingBuckets: profile.paddingBuckets,
      maxSkippedMessageKeys: profile.maxSkippedMessageKeys,
      protocolVersion: profile.protocolVersion,
    });
  }

  generateIdentity(): Promise<Uint8Array> {
    return this.serialRequest("GENERATE_IDENTITY");
  }

  establishSession(
    peerPublicKey: Uint8Array,
    profileHashValue: string,
  ): Promise<boolean> {
    return this.serialRequest("ESTABLISH_SESSION", {
      peerPublicKey,
      profileHashValue,
    });
  }

  async encrypt(
    data: Uint8Array,
    aadContext: AadContext,
  ): Promise<EncryptedPayload> {
    const result = await this.serialRequest<{
      ciphertext: Uint8Array;
      nonce: Uint8Array;
      counter: string | bigint;
    }>("ENCRYPT", { data, aadContext });
    return {
      ciphertext: result.ciphertext,
      nonce: result.nonce,
      counter:
        typeof result.counter === "bigint"
          ? result.counter
          : BigInt(result.counter),
    };
  }

  decrypt(
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    counter: bigint,
    aadContext: AadContext,
  ): Promise<Uint8Array> {
    return this.serialRequest("DECRYPT", {
      ciphertext,
      nonce,
      counter: counter.toString(),
      aadContext,
    });
  }

  reset(): Promise<boolean> {
    return this.serialRequest("RESET");
  }

  private serialRequest<T>(type: string, payload?: unknown): Promise<T> {
    const run = () => this.rawRequest<T>(type, payload);
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async waitReady(): Promise<void> {
    if (this.ready) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Crypto worker ready timeout")),
        READY_TIMEOUT_MS,
      );
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async rawRequest<T>(type: string, payload?: unknown): Promise<T> {
    await this.waitReady();
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Crypto operation timed out: ${type}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker.postMessage({ id, type, payload });
    });
  }
}
