import {
  isTransportProfileId,
  type TransportProfileId,
} from "../config/profiles";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  utf8Decode,
  utf8Encode,
} from "../utils/bytes";
import {
  optionalNumber,
  optionalString,
  parseJsonObject,
  requireInteger,
  requireString,
} from "../utils/safeJson";

export const PRODUCT_VERSION = "2.0.0-beta.3";
export const MAX_TEXT_MESSAGE_CHARS = 8_000;
export const APP_VERSION = `onlytwo-client-${PRODUCT_VERSION}`;
export const FEATURE_FLAGS = [
  "text.v2",
  "file.window.v1",
  "voice.pcm16.v2",
  "verify.phrase.v1",
  "reliable.v1",
  "voice.vad.v1",
  "voice.queue.v1",
  "relay.lifecycle.v1",
  "room.profile.v1",
] as const;

export interface HandshakeMessage {
  kind: "handshake.v2";
  publicKey: string;
  profileId: TransportProfileId;
  profileHash: string;
  appVersion: string;
  featureFlags: string[];
}

export type ReliableChannelName = "control" | "text";

export type CoreAppMessage =
  | { kind: "session.verified"; at: number }
  | { kind: "text.message"; messageId: string; body: string; createdAt: number }
  | {
      kind: "file.offer";
      fileId: string;
      name: string;
      mime: string;
      size: number;
      chunkSize: number;
      totalChunks: number;
      sha256?: string;
    }
  | { kind: "file.accept"; fileId: string }
  | { kind: "file.reject"; fileId: string; reason: string }
  | {
      kind: "file.chunk";
      fileId: string;
      index: number;
      totalChunks: number;
      data: string;
    }
  | { kind: "file.ack"; fileId: string; index: number }
  | { kind: "file.nack"; fileId: string; index: number; reason: string }
  | { kind: "file.pause"; fileId: string; reason: string }
  | { kind: "file.resume"; fileId: string }
  | { kind: "file.cancel"; fileId: string; reason: string }
  | { kind: "file.complete"; fileId: string; sha256?: string }
  | {
      kind: "voice.start";
      streamId: string;
      sampleRate: number;
      frameMs: number;
      mode?: "efficient" | "maximum_privacy";
    }
  | {
      kind: "voice.frame";
      streamId: string;
      seq: number;
      sentAt: number;
      sampleRate: number;
      frameMs: number;
      pcm16: string;
    }
  | { kind: "voice.stop"; streamId: string };

export type ReliableBodyMessage = Exclude<
  CoreAppMessage,
  | { kind: "file.chunk" }
  | { kind: "file.ack" }
  | { kind: "file.nack" }
  | { kind: "voice.frame" }
>;

export type ReliableEnvelopeMessage =
  | {
      kind: "reliable.msg";
      id: string;
      channel: ReliableChannelName;
      body: ReliableBodyMessage;
      createdAt: number;
      attempt: number;
    }
  | { kind: "reliable.ack"; id: string }
  | { kind: "reliable.nack"; id: string; reason: string };

export type AppMessage = CoreAppMessage | ReliableEnvelopeMessage;

export function encodeHandshake(message: HandshakeMessage): Uint8Array {
  return utf8Encode(JSON.stringify(message));
}

export function decodeHandshake(bytes: Uint8Array): HandshakeMessage {
  const obj = parseJsonObject(utf8Decode(bytes));
  if (obj.kind !== "handshake.v2") throw new Error("Unsupported handshake");
  const featureFlags = obj.featureFlags;
  if (
    !Array.isArray(featureFlags) ||
    featureFlags.length > 64 ||
    featureFlags.some(
      (v) => typeof v !== "string" || v.length === 0 || v.length > 64,
    )
  )
    throw new Error("Invalid feature flags");
  const profileId = requireString(obj, "profileId");
  const profileHashValue = requireString(obj, "profileHash");
  if (!isTransportProfileId(profileId)) throw new Error("Invalid room profile");
  if (!/^[a-f0-9]{32}$/.test(profileHashValue))
    throw new Error("Invalid profile hash");
  return {
    kind: "handshake.v2",
    publicKey: boundedString(obj, "publicKey", 100),
    profileId,
    profileHash: profileHashValue,
    appVersion: boundedOptionalString(obj, "appVersion", "unknown", 100),
    featureFlags: featureFlags as string[],
  };
}

export function encodeAppMessage(message: AppMessage): Uint8Array {
  return utf8Encode(JSON.stringify(message));
}

export function decodeAppMessage(bytes: Uint8Array): AppMessage {
  const obj = parseJsonObject(utf8Decode(bytes));
  return decodeAppMessageObject(obj);
}

function decodeAppMessageObject(obj: Record<string, unknown>): AppMessage {
  switch (obj.kind) {
    case "reliable.msg": {
      const channel = requireString(obj, "channel");
      if (channel !== "control" && channel !== "text")
        throw new Error("Invalid reliable channel");
      const body = obj.body;
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Invalid reliable body");
      const decodedBody = decodeCoreAppMessageObject(
        body as Record<string, unknown>,
      );
      if (!isReliableBody(decodedBody))
        throw new Error("Message kind is not reliable-wrappable");
      return {
        kind: "reliable.msg",
        id: boundedString(obj, "id", 160),
        channel,
        body: decodedBody,
        createdAt: optionalTimestamp(obj, "createdAt"),
        attempt: requireInteger(obj, "attempt", 1),
      };
    }
    case "reliable.ack":
      return { kind: "reliable.ack", id: boundedString(obj, "id", 160) };
    case "reliable.nack":
      return {
        kind: "reliable.nack",
        id: boundedString(obj, "id", 160),
        reason: boundedString(obj, "reason", 240),
      };
    default:
      return decodeCoreAppMessageObject(obj);
  }
}

function decodeCoreAppMessageObject(
  obj: Record<string, unknown>,
): CoreAppMessage {
  switch (obj.kind) {
    case "session.verified":
      return {
        kind: "session.verified",
        at: optionalTimestamp(obj, "at"),
      };
    case "text.message":
      return {
        kind: "text.message",
        messageId: boundedString(obj, "messageId", 160),
        body: boundedString(obj, "body", MAX_TEXT_MESSAGE_CHARS),
        createdAt: optionalTimestamp(obj, "createdAt"),
      };
    case "file.offer": {
      const sha256 = optionalSha256(obj);
      return {
        kind: "file.offer",
        fileId: boundedString(obj, "fileId", 160),
        name: boundedString(obj, "name", 180),
        mime: boundedOptionalString(
          obj,
          "mime",
          "application/octet-stream",
          160,
        ),
        size: requireInteger(obj, "size", 1),
        chunkSize: requireInteger(obj, "chunkSize", 1),
        totalChunks: requireInteger(obj, "totalChunks", 1),
        ...(sha256 ? { sha256 } : {}),
      };
    }
    case "file.accept":
      return { kind: "file.accept", fileId: boundedString(obj, "fileId", 160) };
    case "file.reject":
      return {
        kind: "file.reject",
        fileId: boundedString(obj, "fileId", 160),
        reason: boundedString(obj, "reason", 240),
      };
    case "file.chunk":
      return {
        kind: "file.chunk",
        fileId: boundedString(obj, "fileId", 160),
        index: requireInteger(obj, "index", 0),
        totalChunks: requireInteger(obj, "totalChunks", 1),
        data: boundedString(obj, "data", 400_000),
      };
    case "file.ack":
      return {
        kind: "file.ack",
        fileId: boundedString(obj, "fileId", 160),
        index: requireInteger(obj, "index", 0),
      };
    case "file.nack":
      return {
        kind: "file.nack",
        fileId: boundedString(obj, "fileId", 160),
        index: requireInteger(obj, "index", 0),
        reason: boundedString(obj, "reason", 240),
      };
    case "file.pause":
      return {
        kind: "file.pause",
        fileId: boundedString(obj, "fileId", 160),
        reason: boundedString(obj, "reason", 240),
      };
    case "file.resume":
      return { kind: "file.resume", fileId: boundedString(obj, "fileId", 160) };
    case "file.cancel":
      return {
        kind: "file.cancel",
        fileId: boundedString(obj, "fileId", 160),
        reason: boundedString(obj, "reason", 240),
      };
    case "file.complete": {
      const sha256 = optionalSha256(obj);
      return {
        kind: "file.complete",
        fileId: boundedString(obj, "fileId", 160),
        ...(sha256 ? { sha256 } : {}),
      };
    }
    case "voice.start": {
      const rawMode = optionalString(obj, "mode", "");
      if (rawMode && rawMode !== "efficient" && rawMode !== "maximum_privacy") {
        throw new Error("Invalid voice mode");
      }

      const mode = rawMode as "" | "efficient" | "maximum_privacy";

      return {
        kind: "voice.start",
        streamId: boundedString(obj, "streamId", 80),
        sampleRate: requireInteger(obj, "sampleRate", 1),
        frameMs: requireInteger(obj, "frameMs", 1),
        ...(mode ? { mode } : {}),
      };
    }
    case "voice.frame":
      return {
        kind: "voice.frame",
        streamId: boundedString(obj, "streamId", 80),
        seq: requireInteger(obj, "seq", 0),
        sentAt: requireInteger(obj, "sentAt", 0),
        sampleRate: requireInteger(obj, "sampleRate", 1),
        frameMs: requireInteger(obj, "frameMs", 1),
        pcm16: boundedString(obj, "pcm16", 400_000),
      };
    case "voice.stop":
      return {
        kind: "voice.stop",
        streamId: boundedString(obj, "streamId", 80),
      };
    default:
      throw new Error("Unknown app message");
  }
}

function boundedString(
  obj: Record<string, unknown>,
  key: string,
  max: number,
): string {
  const value = requireString(obj, key);
  if (value.length === 0 || value.length > max)
    throw new Error(`Invalid string: ${key}`);
  return value;
}

function boundedOptionalString(
  obj: Record<string, unknown>,
  key: string,
  fallback: string,
  max: number,
): string {
  const value = optionalString(obj, key, fallback);
  if (value.length > max) throw new Error(`Invalid string: ${key}`);
  return value;
}

function optionalSha256(obj: Record<string, unknown>): string {
  const value = optionalString(obj, "sha256", "");
  if (value && !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid sha256");
  return value;
}

function optionalTimestamp(obj: Record<string, unknown>, key: string): number {
  const value = optionalNumber(obj, key, Date.now());
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    return Date.now();
  }
  return value;
}

export function isReliableBody(
  message: CoreAppMessage,
): message is ReliableBodyMessage {
  switch (message.kind) {
    case "file.chunk":
    case "file.ack":
    case "file.nack":
    case "voice.frame":
      return false;
    default:
      return true;
  }
}

export const bytesToPayload = bytesToBase64Url;
export const payloadToBytes = base64UrlToBytes;
