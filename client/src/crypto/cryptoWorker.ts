/// <reference lib="webworker" />

import { bufferFromBytes, randomBytes, utf8Encode } from "../utils/bytes";
import { encodeAad, type AadContext } from "../protocol/envelope";

const NONCE_BYTES = 12;
const X25519_PUBLIC_BYTES = 32;
const AES_KEY_BYTES = 32;
const ZERO_32 = new Uint8Array(32);
const ROOT_INFO = utf8Encode("onlytwo-v2-root");
const CHAIN_SEND_INFO = utf8Encode("onlytwo-v2-chain-send");
const CHAIN_RECV_INFO = utf8Encode("onlytwo-v2-chain-recv");
const CHAIN_STEP_INFO = utf8Encode("onlytwo-v2-chain-step");

interface WorkerRequest {
  id: string;
  type: string;
  payload?: unknown;
}
interface CryptoConfig {
  paddingBuckets: number[];
  maxSkippedMessageKeys: number;
  protocolVersion: number;
}
interface EncryptRequest {
  data: unknown;
  aadContext: AadContext;
}
interface DecryptRequest {
  ciphertext: unknown;
  nonce: unknown;
  counter: unknown;
  aadContext: AadContext;
}

let config: CryptoConfig = {
  paddingBuckets: [4096, 16384, 65536, 131072],
  maxSkippedMessageKeys: 4096,
  protocolVersion: 2,
};
let identityKeyPair: CryptoKeyPair | null = null;
let identityPublicRaw: Uint8Array | null = null;
let rootKey: Uint8Array | null = null;
let sendChainKey: Uint8Array | null = null;
let receiveChainKey: Uint8Array | null = null;
let outboundCounter = 0n;
let highestInboundCounter = 0n;
let sessionEstablished = false;
const skippedKeys = new Map<bigint, Uint8Array>();
let workerChain: Promise<void> = Promise.resolve();

function clone(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}
function zeroize(bytes: Uint8Array | null | undefined): void {
  if (bytes) bytes.fill(0);
}

function toBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error(`Invalid ${label}`);
}

function toCounter(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error("Invalid counter");
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    bufferFromBytes(ikm),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bufferFromBytes(salt),
      info: bufferFromBytes(info),
    },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function importAes(
  raw: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  if (raw.byteLength !== AES_KEY_BYTES) throw new Error("Invalid AES key");
  return crypto.subtle.importKey(
    "raw",
    bufferFromBytes(raw),
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

async function importX25519Public(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== X25519_PUBLIC_BYTES)
    throw new Error("Invalid X25519 public key");
  return crypto.subtle.importKey(
    "raw",
    bufferFromBytes(raw),
    { name: "X25519" },
    false,
    [],
  );
}

async function generateIdentity(): Promise<Uint8Array> {
  resetAll();
  identityKeyPair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  identityPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", identityKeyPair.publicKey),
  );
  return clone(identityPublicRaw);
}

async function establishSession(
  peerRaw: Uint8Array,
  profileHashValue: string,
): Promise<boolean> {
  if (!identityKeyPair || !identityPublicRaw)
    throw new Error("Identity not generated");
  if (peerRaw.byteLength !== X25519_PUBLIC_BYTES)
    throw new Error("Invalid peer public key");
  if (compareBytes(identityPublicRaw, peerRaw) === 0)
    throw new Error("Refusing identical peer key");
  resetSession();

  const peerKey = await importX25519Public(peerRaw);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "X25519", public: peerKey },
      identityKeyPair.privateKey,
      256,
    ),
  );
  const salt = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      bufferFromBytes(utf8Encode(`onlytwo-v2:${profileHashValue}`)),
    ),
  );
  rootKey = await hkdf(shared, salt, ROOT_INFO, AES_KEY_BYTES);

  const localIsLower = compareBytes(identityPublicRaw, peerRaw) < 0;
  sendChainKey = await hkdf(
    rootKey,
    ZERO_32,
    localIsLower ? CHAIN_SEND_INFO : CHAIN_RECV_INFO,
    AES_KEY_BYTES,
  );
  receiveChainKey = await hkdf(
    rootKey,
    ZERO_32,
    localIsLower ? CHAIN_RECV_INFO : CHAIN_SEND_INFO,
    AES_KEY_BYTES,
  );

  zeroize(shared);
  zeroize(rootKey);
  rootKey = null;
  sessionEstablished = true;
  return true;
}

async function deriveStep(
  chainKey: Uint8Array,
): Promise<{ next: Uint8Array; message: Uint8Array }> {
  const material = await hkdf(
    chainKey,
    ZERO_32,
    CHAIN_STEP_INFO,
    AES_KEY_BYTES * 2,
  );
  return {
    next: material.slice(0, AES_KEY_BYTES),
    message: material.slice(AES_KEY_BYTES),
  };
}

function selectPaddingBucket(actualBytes: number): number {
  const needed = actualBytes + 4;
  for (const bucket of [...config.paddingBuckets].sort((a, b) => a - b))
    if (needed <= bucket) return bucket;
  throw new Error("Payload too large for selected profile");
}

function buildPlaintext(actual: Uint8Array): Uint8Array {
  const out = randomBytes(selectPaddingBucket(actual.byteLength));
  new DataView(out.buffer).setUint32(0, actual.byteLength, false);
  out.set(actual, 4);
  return out;
}

function parsePlaintext(padded: Uint8Array): Uint8Array {
  if (!config.paddingBuckets.includes(padded.byteLength))
    throw new Error("Invalid padded plaintext size");
  const length = new DataView(
    padded.buffer,
    padded.byteOffset,
    padded.byteLength,
  ).getUint32(0, false);
  if (length > padded.byteLength - 4)
    throw new Error("Invalid plaintext length");
  return padded.slice(4, 4 + length);
}

function cacheSkipped(counter: bigint, key: Uint8Array): void {
  const old = skippedKeys.get(counter);
  if (old) zeroize(old);
  skippedKeys.set(counter, key);
  while (skippedKeys.size > config.maxSkippedMessageKeys) {
    const oldest = skippedKeys.keys().next().value as bigint | undefined;
    if (oldest === undefined) break;
    zeroize(skippedKeys.get(oldest));
    skippedKeys.delete(oldest);
  }
}

async function encryptBinary(
  payload: EncryptRequest,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array; counter: string }> {
  if (!sessionEstablished || !sendChainKey)
    throw new Error("Session not established");
  const data = toBytes(payload.data, "plaintext");
  const step = await deriveStep(sendChainKey);
  zeroize(sendChainKey);
  sendChainKey = step.next;
  outboundCounter += 1n;
  const counter = outboundCounter;
  const nonce = randomBytes(NONCE_BYTES);
  const aad = encodeAad(payload.aadContext, counter, nonce);
  const aes = await importAes(step.message, ["encrypt"]);
  const plaintext = buildPlaintext(data);
  try {
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: bufferFromBytes(nonce),
          additionalData: bufferFromBytes(aad),
        },
        aes,
        bufferFromBytes(plaintext),
      ),
    );
    return { ciphertext, nonce, counter: counter.toString() };
  } finally {
    zeroize(step.message);
    zeroize(plaintext);
  }
}

async function decryptBinary(payload: DecryptRequest): Promise<Uint8Array> {
  if (!sessionEstablished || !receiveChainKey)
    throw new Error("Session not established");
  const ciphertext = toBytes(payload.ciphertext, "ciphertext");
  const nonce = toBytes(payload.nonce, "nonce");
  const counter = toCounter(payload.counter);
  if (nonce.byteLength !== NONCE_BYTES) throw new Error("Invalid nonce length");
  if (
    counter >
    highestInboundCounter + BigInt(config.maxSkippedMessageKeys + 1)
  )
    throw new Error("Counter too far ahead");

  let messageKey: Uint8Array;
  let nextChain = receiveChainKey;
  let nextHighest = highestInboundCounter;
  const cached = skippedKeys.get(counter);

  if (cached) {
    messageKey = clone(cached);
  } else {
    if (counter <= highestInboundCounter) throw new Error("Replay detected");
    let cursor = receiveChainKey;
    for (let c = highestInboundCounter + 1n; c < counter; c += 1n) {
      const skipped = await deriveStep(cursor);
      if (cursor !== receiveChainKey) zeroize(cursor);
      cacheSkipped(c, skipped.message);
      cursor = skipped.next;
    }
    const step = await deriveStep(cursor);
    if (cursor !== receiveChainKey) zeroize(cursor);
    messageKey = step.message;
    nextChain = step.next;
    nextHighest = counter;
  }

  const aad = encodeAad(payload.aadContext, counter, nonce);
  const aes = await importAes(messageKey, ["decrypt"]);
  let padded: Uint8Array | null = null;
  try {
    padded = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bufferFromBytes(nonce),
          additionalData: bufferFromBytes(aad),
        },
        aes,
        bufferFromBytes(ciphertext),
      ),
    );
    if (!cached) {
      zeroize(receiveChainKey);
      receiveChainKey = nextChain;
      highestInboundCounter = nextHighest;
    }
    if (cached) {
      zeroize(cached);
      skippedKeys.delete(counter);
    }
    return parsePlaintext(padded);
  } finally {
    zeroize(messageKey);
    zeroize(padded);
  }
}

function resetSession(): void {
  zeroize(rootKey);
  zeroize(sendChainKey);
  zeroize(receiveChainKey);
  rootKey = null;
  sendChainKey = null;
  receiveChainKey = null;
  outboundCounter = 0n;
  highestInboundCounter = 0n;
  sessionEstablished = false;
  for (const key of skippedKeys.values()) zeroize(key);
  skippedKeys.clear();
}

function resetAll(): void {
  resetSession();
  identityKeyPair = null;
  zeroize(identityPublicRaw);
  identityPublicRaw = null;
}

async function handle(req: WorkerRequest): Promise<void> {
  switch (req.type) {
    case "CONFIGURE": {
      const payload = req.payload as Partial<CryptoConfig> | undefined;
      const buckets = Array.isArray(payload?.paddingBuckets)
        ? payload.paddingBuckets
            .map(Number)
            .filter((n) => Number.isInteger(n) && n >= 1024)
        : config.paddingBuckets;
      config = {
        paddingBuckets: [...new Set(buckets)].sort((a, b) => a - b),
        maxSkippedMessageKeys: Math.min(
          1024,
          Math.max(
            32,
            Number(
              payload?.maxSkippedMessageKeys ?? config.maxSkippedMessageKeys,
            ),
          ),
        ),
        protocolVersion: Number(
          payload?.protocolVersion ?? config.protocolVersion,
        ),
      };
      resetSession();
      post(req.id, true);
      return;
    }
    case "GENERATE_IDENTITY":
      post(req.id, await generateIdentity());
      return;
    case "ESTABLISH_SESSION": {
      const payload = req.payload as {
        peerPublicKey?: unknown;
        profileHashValue?: unknown;
      };
      post(
        req.id,
        await establishSession(
          toBytes(payload.peerPublicKey, "peer public key"),
          String(payload.profileHashValue ?? ""),
        ),
      );
      return;
    }
    case "ENCRYPT":
      post(req.id, await encryptBinary(req.payload as EncryptRequest));
      return;
    case "DECRYPT":
      post(req.id, await decryptBinary(req.payload as DecryptRequest));
      return;
    case "RESET":
      resetAll();
      post(req.id, true);
      return;
    default:
      throw new Error(`Unknown crypto request: ${req.type}`);
  }
}

function post(id: string, result: unknown): void {
  self.postMessage({ id, result });
}
function postError(id: string, error: unknown): void {
  self.postMessage({
    id,
    error: error instanceof Error ? error.message : String(error),
  });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  workerChain = workerChain
    .then(
      () => handle(req),
      () => handle(req),
    )
    .catch((err) => postError(req?.id ?? "", err));
};

self.postMessage({ type: "READY" });
