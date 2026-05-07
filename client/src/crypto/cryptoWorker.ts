/// <reference lib="webworker" />

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PLAINTEXT_BYTES = 65_536;
const NONCE_BYTES = 12;
const X25519_PUBLIC_BYTES = 32;
const AES_KEY_BYTES = 32;
const MAX_ACTUAL_BYTES_NO_DH = PLAINTEXT_BYTES - 3;
const MAX_ACTUAL_BYTES_WITH_DH = PLAINTEXT_BYTES - 3 - X25519_PUBLIC_BYTES;
const DH_RATCHET_INTERVAL = 50n;
const MAX_SKIPPED_MESSAGE_KEYS = 2_048;

const ROOT_SALT = encoder.encode("onlytwo-v2-root");
const ROOT_INFO = encoder.encode("root");
const CHAIN_INFO_INITIAL_SEND = encoder.encode("onlytwo-v2-chain-initial-send");
const CHAIN_INFO_INITIAL_RECV = encoder.encode("onlytwo-v2-chain-initial-recv");
const CHAIN_INFO_ACTIVE = encoder.encode("onlytwo-v2-chain-active");
const CHAIN_STEP_INFO = encoder.encode("onlytwo-v2-chain-step");
const ZERO_32 = new Uint8Array(32);

interface WorkerRequest {
  type: string;
  payload?: unknown;
  id: string;
}

interface EncryptResult {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  counter: bigint;
}

interface DecryptPayload {
  ciphertext: BufferSource;
  nonce: BufferSource;
  counter: bigint | number | string;
}

let identityKeyPair: CryptoKeyPair | null = null;
let identityPubRaw: Uint8Array | null = null;

let peerIdentityPubRaw: Uint8Array | null = null;
let peerIdentityPubKey: CryptoKey | null = null;

let rootKey: Uint8Array | null = null;
let sendChainKey: Uint8Array | null = null;
let receiveChainKey: Uint8Array | null = null;

let sendChainStep = 0n;
let receiveChainStep = 0n;
let highestInboundCounter = 0n;
let highestOutboundCounter = 0n;
let lastAppliedRatchetCounter = 0n;

let localRatchetKeyPair: CryptoKeyPair | null = null;
let localRatchetPubRaw: Uint8Array | null = null;
let remoteRatchetPubRaw: Uint8Array | null = null;

let pendingSendRatchetKeyPair: CryptoKeyPair | null = null;
let pendingSendRatchetPubRaw: Uint8Array | null = null;

let sessionEstablished = false;

const skippedMessageKeys = new Map<bigint, Uint8Array>();
const consumedInboundCounters = new Set<bigint>();

function zeroizeBytes(bytes: Uint8Array | null): void {
  if (bytes) {
    bytes.fill(0);
  }
}

function cloneBytes(input: Uint8Array): Uint8Array {
  return new Uint8Array(input);
}

function toBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value as number[]);
  }
  throw new Error(`Invalid ${label}`);
}

function toBigIntCounter(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Invalid counter");
    }
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && value.length > 0) {
    return BigInt(value);
  }
  throw new Error("Invalid counter");
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (length > 0) {
    crypto.getRandomValues(bytes);
  }
  return bytes;
}

async function importHkdfKey(ikm: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bufferFromBytes(ikm), "HKDF", false, [
    "deriveBits",
  ]);
}

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  const hkdfKey = await importHkdfKey(ikm);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bufferFromBytes(salt),
      info: bufferFromBytes(info),
    },
    hkdfKey,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

async function importX25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== X25519_PUBLIC_BYTES) {
    throw new Error("Invalid X25519 public key length");
  }
  return crypto.subtle.importKey(
    "raw",
    bufferFromBytes(raw),
    { name: "X25519" },
    false,
    [],
  );
}

async function deriveX25519SharedSecret(
  privateKey: CryptoKey,
  publicRaw: Uint8Array,
): Promise<Uint8Array> {
  const publicKey = await importX25519PublicKey(publicRaw);
  const shared = await crypto.subtle.deriveBits(
    { name: "X25519", public: publicKey },
    privateKey,
    256,
  );
  return new Uint8Array(shared);
}

async function deriveMessageStep(
  chainKey: Uint8Array,
): Promise<{ messageKey: Uint8Array; nextChainKey: Uint8Array }> {
  const material = await hkdf(
    chainKey,
    ZERO_32,
    CHAIN_STEP_INFO,
    AES_KEY_BYTES * 2,
  );
  return {
    nextChainKey: material.slice(0, AES_KEY_BYTES),
    messageKey: material.slice(AES_KEY_BYTES),
  };
}

async function importAesGcmKey(
  rawKey: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  if (rawKey.length !== AES_KEY_BYTES) {
    throw new Error("Invalid AES key length");
  }
  return crypto.subtle.importKey(
    "raw",
    bufferFromBytes(rawKey),
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function buildPaddedPlaintext(
  actualData: Uint8Array,
  dhPublicKey: Uint8Array | null,
): Uint8Array {
  const includeDh = dhPublicKey !== null;
  const maxActualBytes = includeDh
    ? MAX_ACTUAL_BYTES_WITH_DH
    : MAX_ACTUAL_BYTES_NO_DH;

  if (actualData.length > maxActualBytes) {
    throw new Error(
      includeDh
        ? `Payload too large for DH-ratchet frame (max ${MAX_ACTUAL_BYTES_WITH_DH} bytes)`
        : `Payload too large (max ${MAX_ACTUAL_BYTES_NO_DH} bytes)`,
    );
  }

  const padded = new Uint8Array(PLAINTEXT_BYTES);
  const view = new DataView(padded.buffer);
  view.setUint16(0, actualData.length, false);
  padded[2] = includeDh ? 1 : 0;

  let offset = 3;
  if (includeDh && dhPublicKey) {
    padded.set(dhPublicKey, offset);
    offset += X25519_PUBLIC_BYTES;
  }

  padded.set(actualData, offset);
  const paddingStart = offset + actualData.length;
  if (paddingStart < PLAINTEXT_BYTES) {
    crypto.getRandomValues(padded.subarray(paddingStart));
  }

  return padded;
}

function parsePaddedPlaintext(padded: Uint8Array): {
  actualData: Uint8Array;
  dhPublicKey: Uint8Array | null;
} {
  if (padded.length !== PLAINTEXT_BYTES) {
    throw new Error("Invalid padded plaintext length");
  }

  const view = new DataView(
    padded.buffer,
    padded.byteOffset,
    padded.byteLength,
  );
  const actualLen = view.getUint16(0, false);
  const flag = padded[2];

  if (flag !== 0 && flag !== 1) {
    throw new Error("Invalid DH flag");
  }

  let offset = 3;
  let dhPublicKey: Uint8Array | null = null;
  if (flag === 1) {
    if (offset + X25519_PUBLIC_BYTES > padded.length) {
      throw new Error("Invalid ratchet payload");
    }
    dhPublicKey = padded.slice(offset, offset + X25519_PUBLIC_BYTES);
    offset += X25519_PUBLIC_BYTES;
  }

  if (actualLen > padded.length - offset) {
    throw new Error("Invalid actual length");
  }

  const actualData = padded.slice(offset, offset + actualLen);
  return { actualData, dhPublicKey };
}

async function generateIdentityKeyPair(): Promise<Uint8Array> {
  identityKeyPair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;

  identityPubRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", identityKeyPair.publicKey),
  );
  return cloneBytes(identityPubRaw);
}

function clearSkippedMessageKeys(): void {
  for (const value of skippedMessageKeys.values()) {
    zeroizeBytes(value);
  }
  skippedMessageKeys.clear();
}

function clearConsumedCounters(): void {
  consumedInboundCounters.clear();
}

function resetSessionState(keepIdentity = false): void {
  if (sendChainKey) zeroizeBytes(sendChainKey);
  if (receiveChainKey) zeroizeBytes(receiveChainKey);
  if (rootKey) zeroizeBytes(rootKey);
  if (pendingSendRatchetPubRaw) zeroizeBytes(pendingSendRatchetPubRaw);
  if (localRatchetPubRaw) zeroizeBytes(localRatchetPubRaw);
  if (remoteRatchetPubRaw) zeroizeBytes(remoteRatchetPubRaw);
  if (identityPubRaw && !keepIdentity) zeroizeBytes(identityPubRaw);
  if (peerIdentityPubRaw) zeroizeBytes(peerIdentityPubRaw);

  for (const value of skippedMessageKeys.values()) {
    zeroizeBytes(value);
  }

  identityKeyPair = keepIdentity ? identityKeyPair : null;
  identityPubRaw = keepIdentity ? identityPubRaw : null;
  peerIdentityPubRaw = null;
  peerIdentityPubKey = null;
  rootKey = null;
  sendChainKey = null;
  receiveChainKey = null;
  sendChainStep = 0n;
  receiveChainStep = 0n;
  highestInboundCounter = 0n;
  highestOutboundCounter = 0n;
  lastAppliedRatchetCounter = 0n;
  localRatchetKeyPair = null;
  localRatchetPubRaw = null;
  remoteRatchetPubRaw = null;
  pendingSendRatchetKeyPair = null;
  pendingSendRatchetPubRaw = null;
  sessionEstablished = false;
  clearSkippedMessageKeys();
  clearConsumedCounters();
}

function cacheSkippedMessageKey(counter: bigint, messageKey: Uint8Array): void {
  const existing = skippedMessageKeys.get(counter);
  if (existing) {
    zeroizeBytes(existing);
  }
  skippedMessageKeys.set(counter, messageKey);
  while (skippedMessageKeys.size > MAX_SKIPPED_MESSAGE_KEYS) {
    const oldest = skippedMessageKeys.keys().next().value as bigint | undefined;
    if (oldest === undefined) break;
    const removed = skippedMessageKeys.get(oldest);
    if (removed) zeroizeBytes(removed);
    skippedMessageKeys.delete(oldest);
  }
}

async function deriveInitialChains(
  myPub: Uint8Array,
  peerPub: Uint8Array,
  sharedSecret: Uint8Array,
): Promise<void> {
  rootKey = await hkdf(sharedSecret, ROOT_SALT, ROOT_INFO, AES_KEY_BYTES);

  const myIsLower = compareBytes(myPub, peerPub) < 0;
  if (myIsLower) {
    sendChainKey = await hkdf(
      rootKey,
      ZERO_32,
      CHAIN_INFO_INITIAL_SEND,
      AES_KEY_BYTES,
    );
    receiveChainKey = await hkdf(
      rootKey,
      ZERO_32,
      CHAIN_INFO_INITIAL_RECV,
      AES_KEY_BYTES,
    );
  } else {
    sendChainKey = await hkdf(
      rootKey,
      ZERO_32,
      CHAIN_INFO_INITIAL_RECV,
      AES_KEY_BYTES,
    );
    receiveChainKey = await hkdf(
      rootKey,
      ZERO_32,
      CHAIN_INFO_INITIAL_SEND,
      AES_KEY_BYTES,
    );
  }

  sendChainStep = 0n;
  receiveChainStep = 0n;
  highestInboundCounter = 0n;
  highestOutboundCounter = 0n;
  lastAppliedRatchetCounter = 0n;

  localRatchetKeyPair = identityKeyPair;
  localRatchetPubRaw = cloneBytes(myPub);
  remoteRatchetPubRaw = cloneBytes(peerPub);
}

async function deriveFingerprint(
  myPub: Uint8Array,
  peerPub: Uint8Array,
): Promise<string> {
  const ordered =
    compareBytes(myPub, peerPub) < 0
      ? concatBytes(myPub, peerPub)
      : concatBytes(peerPub, myPub);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bufferFromBytes(ordered)),
  );
  return bytesToHex(digest.slice(0, 4)).toUpperCase();
}

async function ensurePendingSendRatchet(): Promise<void> {
  if (!sessionEstablished || pendingSendRatchetKeyPair || !sendChainKey) {
    return;
  }

  const nextIndex = sendChainStep + 1n;
  if (nextIndex % DH_RATCHET_INTERVAL !== 0n) {
    return;
  }

  pendingSendRatchetKeyPair = (await crypto.subtle.generateKey(
    { name: "X25519" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  pendingSendRatchetPubRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pendingSendRatchetKeyPair.publicKey),
  );
}

async function applySendingRatchet(): Promise<void> {
  if (
    !pendingSendRatchetKeyPair ||
    !pendingSendRatchetPubRaw ||
    !remoteRatchetPubRaw ||
    !rootKey
  ) {
    throw new Error("Sending ratchet unavailable");
  }

  const dhShared = await deriveX25519SharedSecret(
    pendingSendRatchetKeyPair.privateKey,
    remoteRatchetPubRaw,
  );
  const newRoot = await hkdf(dhShared, rootKey, ROOT_INFO, AES_KEY_BYTES);
  const newSendChain = await hkdf(
    newRoot,
    ZERO_32,
    CHAIN_INFO_ACTIVE,
    AES_KEY_BYTES,
  );

  if (rootKey) zeroizeBytes(rootKey);
  if (sendChainKey) zeroizeBytes(sendChainKey);

  rootKey = newRoot;
  sendChainKey = newSendChain;
  sendChainStep = 0n;
  localRatchetKeyPair = pendingSendRatchetKeyPair;
  localRatchetPubRaw = cloneBytes(pendingSendRatchetPubRaw);
  pendingSendRatchetKeyPair = null;
  pendingSendRatchetPubRaw = null;
}

async function deriveReceivingRatchetState(
  receivedRatchetPubRaw: Uint8Array,
): Promise<{ newRoot: Uint8Array; newReceiveChain: Uint8Array }> {
  if (!localRatchetKeyPair || !rootKey) {
    throw new Error("Receiving ratchet unavailable");
  }

  const dhShared = await deriveX25519SharedSecret(
    localRatchetKeyPair.privateKey,
    receivedRatchetPubRaw,
  );
  const newRoot = await hkdf(dhShared, rootKey, ROOT_INFO, AES_KEY_BYTES);
  const newReceiveChain = await hkdf(
    newRoot,
    ZERO_32,
    CHAIN_INFO_ACTIVE,
    AES_KEY_BYTES,
  );
  return { newRoot, newReceiveChain };
}

async function encryptPayload(actualData: Uint8Array): Promise<EncryptResult> {
  if (
    !sessionEstablished ||
    !sendChainKey ||
    !rootKey ||
    !remoteRatchetPubRaw
  ) {
    throw new Error("Session not established");
  }

  await ensurePendingSendRatchet();

  const includeRatchetPub =
    Boolean(pendingSendRatchetPubRaw) &&
    actualData.length <= MAX_ACTUAL_BYTES_WITH_DH;
  const plaintext = buildPaddedPlaintext(
    actualData,
    includeRatchetPub ? pendingSendRatchetPubRaw : null,
  );

  const step = await deriveMessageStep(sendChainKey);
  const aesKey = await importAesGcmKey(step.messageKey, ["encrypt"]);
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bufferFromBytes(nonce) },
    aesKey,
    bufferFromBytes(plaintext),
  );

  zeroizeBytes(step.messageKey);
  const ciphertext = new Uint8Array(ciphertextBuffer);

  highestOutboundCounter += 1n;

  if (sendChainKey) zeroizeBytes(sendChainKey);
  sendChainKey = step.nextChainKey;
  sendChainStep += 1n;

  if (includeRatchetPub) {
    await applySendingRatchet();
  }

  return {
    ciphertext,
    nonce,
    counter: highestOutboundCounter,
  };
}

async function decryptPayload(
  payload: DecryptPayload,
): Promise<{ actualData: Uint8Array; dhPublicKey: Uint8Array | null }> {
  if (!sessionEstablished || !receiveChainKey) {
    throw new Error("Session not established");
  }

  const ciphertext = toBytes(payload.ciphertext, "ciphertext");
  const nonce = toBytes(payload.nonce, "nonce");
  const counter = toBigIntCounter(payload.counter);

  if (nonce.length !== NONCE_BYTES) {
    throw new Error("Invalid nonce length");
  }

  if (consumedInboundCounters.has(counter)) {
    throw new Error(`Replay attack detected for counter ${counter.toString()}`);
  }

  const cachedKey = skippedMessageKeys.get(counter);
  const isCached = Boolean(cachedKey);

  let messageKeyRaw: Uint8Array;
  let nextReceiveChainKey = receiveChainKey;
  let nextReceiveChainStep = receiveChainStep;
  let nextHighestInboundCounter = highestInboundCounter;

  if (cachedKey) {
    messageKeyRaw = cloneBytes(cachedKey);
  } else {
    if (counter < highestInboundCounter) {
      throw new Error(
        `Replay attack detected for counter ${counter.toString()}`,
      );
    }

    const gap = counter - highestInboundCounter;
    if (gap <= 0n) {
      throw new Error(
        `Replay attack detected for counter ${counter.toString()}`,
      );
    }

    let chainCursor = receiveChainKey;
    for (let i = 1n; i < gap; i += 1n) {
      const skippedStep = await deriveMessageStep(chainCursor);
      const skippedCounter = highestInboundCounter + i;
      cacheSkippedMessageKey(skippedCounter, skippedStep.messageKey);
      chainCursor = skippedStep.nextChainKey;
    }

    const currentStep = await deriveMessageStep(chainCursor);
    messageKeyRaw = currentStep.messageKey;
    nextReceiveChainKey = currentStep.nextChainKey;
    nextReceiveChainStep = receiveChainStep + gap;
    nextHighestInboundCounter = counter;
  }

  const aesKey = await importAesGcmKey(messageKeyRaw, ["decrypt"]);
  let paddedPlaintext: Uint8Array;
  try {
    const plaintextBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bufferFromBytes(nonce) },
      aesKey,
      bufferFromBytes(ciphertext),
    );
    paddedPlaintext = new Uint8Array(plaintextBuffer);
  } finally {
    zeroizeBytes(messageKeyRaw);
  }

  const parsed = parsePaddedPlaintext(paddedPlaintext);
  const commitCounterToState = !isCached;

  let stagedRootKey = rootKey ? cloneBytes(rootKey) : null;
  let stagedReceiveChainKey = nextReceiveChainKey
    ? cloneBytes(nextReceiveChainKey)
    : null;
  let stagedReceiveChainStep = nextReceiveChainStep;
  let stagedHighestInboundCounter = nextHighestInboundCounter;
  let stagedLastAppliedRatchetCounter = lastAppliedRatchetCounter;

  if (
    parsed.dhPublicKey &&
    commitCounterToState &&
    counter > lastAppliedRatchetCounter
  ) {
    const stagedRatchet = await deriveReceivingRatchetState(parsed.dhPublicKey);
    if (stagedRootKey) zeroizeBytes(stagedRootKey);
    if (stagedReceiveChainKey) zeroizeBytes(stagedReceiveChainKey);
    stagedRootKey = stagedRatchet.newRoot;
    stagedReceiveChainKey = stagedRatchet.newReceiveChain;
    stagedReceiveChainStep = 0n;
    stagedLastAppliedRatchetCounter = counter;
  }

  if (commitCounterToState) {
    if (rootKey) zeroizeBytes(rootKey);
    if (receiveChainKey) zeroizeBytes(receiveChainKey);

    rootKey = stagedRootKey;
    receiveChainKey = stagedReceiveChainKey;
    receiveChainStep = stagedReceiveChainStep;
    highestInboundCounter = stagedHighestInboundCounter;
    lastAppliedRatchetCounter = stagedLastAppliedRatchetCounter;
    if (parsed.dhPublicKey) {
      if (remoteRatchetPubRaw) zeroizeBytes(remoteRatchetPubRaw);
      remoteRatchetPubRaw = cloneBytes(parsed.dhPublicKey);
    }
    consumedInboundCounters.add(counter);

    if (skippedMessageKeys.has(counter)) {
      const cached = skippedMessageKeys.get(counter);
      if (cached) zeroizeBytes(cached);
      skippedMessageKeys.delete(counter);
    }
  } else {
    consumedInboundCounters.add(counter);
    if (skippedMessageKeys.has(counter)) {
      const cached = skippedMessageKeys.get(counter);
      if (cached) zeroizeBytes(cached);
      skippedMessageKeys.delete(counter);
    }
  }

  return parsed;
}

function postError(id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  self.postMessage({ id, error: message });
}

async function handleRequest(message: WorkerRequest): Promise<void> {
  const id =
    typeof message.id === "string" ? message.id : String(message.id ?? "");

  switch (message.type) {
    case "GENERATE_IDENTITY": {
      resetSessionState(false);
      const pub = await generateIdentityKeyPair();
      self.postMessage({ id, result: pub });
      return;
    }

    case "ESTABLISH_SESSION": {
      if (!identityKeyPair || !identityPubRaw) {
        throw new Error("Identity not generated");
      }
      resetSessionState(true);
      if (!identityKeyPair || !identityPubRaw) {
        throw new Error("Identity not generated");
      }

      const peerPubRaw = toBytes(message.payload, "peer public key");
      if (peerPubRaw.length !== X25519_PUBLIC_BYTES) {
        throw new Error("Invalid peer public key length");
      }

      if (compareBytes(identityPubRaw, peerPubRaw) === 0) {
        throw new Error("Public keys are identical; cannot establish session");
      }

      peerIdentityPubRaw = cloneBytes(peerPubRaw);
      peerIdentityPubKey = await importX25519PublicKey(peerPubRaw);

      const sharedSecret = new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: "X25519", public: peerIdentityPubKey },
          identityKeyPair.privateKey,
          256,
        ),
      );

      await deriveInitialChains(identityPubRaw, peerPubRaw, sharedSecret);
      sessionEstablished = true;

      const fingerprint = await deriveFingerprint(identityPubRaw, peerPubRaw);
      self.postMessage({ id, result: { fingerprint } });
      return;
    }

    case "ENCRYPT_TEXT": {
      const plaintext = encoder.encode(String(message.payload ?? ""));
      const result = await encryptPayload(plaintext);
      self.postMessage({ id, result });
      return;
    }

    case "ENCRYPT_BINARY": {
      const binary = toBytes(message.payload, "binary payload");
      const result = await encryptPayload(binary);
      self.postMessage({ id, result });
      return;
    }

    case "DECRYPT_TEXT": {
      const parsed = await decryptPayload(message.payload as DecryptPayload);
      self.postMessage({ id, result: decoder.decode(parsed.actualData) });
      return;
    }

    case "DECRYPT_BINARY": {
      const parsed = await decryptPayload(message.payload as DecryptPayload);
      self.postMessage({ id, result: parsed.actualData });
      return;
    }

    case "RESET": {
      resetSessionState(false);
      self.postMessage({ id, result: true });
      return;
    }

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void handleRequest(event.data).catch((error) => {
    postError(typeof event.data?.id === "string" ? event.data.id : "", error);
  });
};

self.postMessage({ type: "READY" });
