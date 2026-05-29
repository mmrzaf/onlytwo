import type { TransportProfileId } from "../config/profiles";
import { base64UrlToBytes, bytesToBase64Url, utf8Decode, utf8Encode } from "../utils/bytes";
import { optionalNumber, optionalString, parseJsonObject, requireNumber, requireString } from "../utils/safeJson";

export const APP_VERSION = "onlytwo-client-v2";
export const FEATURE_FLAGS = ["text.v2", "file.window.v1", "voice.pcm16.v2", "verify.phrase.v1", "reliable.v1", "voice.vad.v1"] as const;

export interface HandshakeMessage {
  kind: "handshake.v2";
  publicKey: string;
  preferredProfile: TransportProfileId;
  supportedProfiles: TransportProfileId[];
  appVersion: string;
  featureFlags: string[];
}

export type ReliableChannelName = "control" | "text";

export type CoreAppMessage =
  | { kind: "session.verified"; at: number }
  | { kind: "text.message"; messageId: string; body: string; createdAt: number }
  | { kind: "file.offer"; fileId: string; name: string; mime: string; size: number; chunkSize: number; totalChunks: number; sha256?: string }
  | { kind: "file.accept"; fileId: string }
  | { kind: "file.reject"; fileId: string; reason: string }
  | { kind: "file.chunk"; fileId: string; index: number; totalChunks: number; data: string }
  | { kind: "file.ack"; fileId: string; index: number }
  | { kind: "file.nack"; fileId: string; index: number; reason: string }
  | { kind: "file.pause"; fileId: string; reason: string }
  | { kind: "file.resume"; fileId: string }
  | { kind: "file.cancel"; fileId: string; reason: string }
  | { kind: "file.complete"; fileId: string; sha256?: string }
  | { kind: "voice.start"; streamId: string; sampleRate: number; frameMs: number; mode?: "efficient" | "maximum_privacy" }
  | { kind: "voice.frame"; streamId: string; seq: number; sentAt: number; sampleRate: number; frameMs: number; pcm16: string }
  | { kind: "voice.stop"; streamId: string };

export type ReliableBodyMessage = Exclude<
  CoreAppMessage,
  | { kind: "file.chunk" }
  | { kind: "file.ack" }
  | { kind: "file.nack" }
  | { kind: "voice.frame" }
>;

export type ReliableEnvelopeMessage =
  | { kind: "reliable.msg"; id: string; channel: ReliableChannelName; body: ReliableBodyMessage; createdAt: number; attempt: number }
  | { kind: "reliable.ack"; id: string }
  | { kind: "reliable.nack"; id: string; reason: string };

export type AppMessage = CoreAppMessage | ReliableEnvelopeMessage;

export function encodeHandshake(message: HandshakeMessage): Uint8Array {
  return utf8Encode(JSON.stringify(message));
}

export function decodeHandshake(bytes: Uint8Array): HandshakeMessage {
  const obj = parseJsonObject(utf8Decode(bytes));
  if (obj.kind !== "handshake.v2") throw new Error("Unsupported handshake");
  const supported = obj.supportedProfiles;
  if (!Array.isArray(supported) || supported.some((v) => typeof v !== "string")) throw new Error("Invalid supported profiles");
  const featureFlags = obj.featureFlags;
  if (!Array.isArray(featureFlags) || featureFlags.some((v) => typeof v !== "string")) throw new Error("Invalid feature flags");
  return {
    kind: "handshake.v2",
    publicKey: requireString(obj, "publicKey"),
    preferredProfile: requireString(obj, "preferredProfile") as TransportProfileId,
    supportedProfiles: supported as TransportProfileId[],
    appVersion: optionalString(obj, "appVersion", "unknown"),
    featureFlags: featureFlags as string[]
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
      if (channel !== "control" && channel !== "text") throw new Error("Invalid reliable channel");
      const body = obj.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid reliable body");
      const decodedBody = decodeCoreAppMessageObject(body as Record<string, unknown>);
      if (!isReliableBody(decodedBody)) throw new Error("Message kind is not reliable-wrappable");
      return {
        kind: "reliable.msg",
        id: requireString(obj, "id"),
        channel,
        body: decodedBody,
        createdAt: optionalNumber(obj, "createdAt", Date.now()),
        attempt: optionalNumber(obj, "attempt", 1)
      };
    }
    case "reliable.ack":
      return { kind: "reliable.ack", id: requireString(obj, "id") };
    case "reliable.nack":
      return { kind: "reliable.nack", id: requireString(obj, "id"), reason: requireString(obj, "reason") };
    default:
      return decodeCoreAppMessageObject(obj);
  }
}

function decodeCoreAppMessageObject(obj: Record<string, unknown>): CoreAppMessage {
  switch (obj.kind) {
    case "session.verified":
      return { kind: "session.verified", at: optionalNumber(obj, "at", Date.now()) };
    case "text.message":
      return { kind: "text.message", messageId: requireString(obj, "messageId"), body: requireString(obj, "body"), createdAt: optionalNumber(obj, "createdAt", Date.now()) };
    case "file.offer": {
      const sha256 = optionalString(obj, "sha256", "");
      return { kind: "file.offer", fileId: requireString(obj, "fileId"), name: requireString(obj, "name"), mime: optionalString(obj, "mime", "application/octet-stream"), size: requireNumber(obj, "size"), chunkSize: requireNumber(obj, "chunkSize"), totalChunks: requireNumber(obj, "totalChunks"), ...(sha256 ? { sha256 } : {}) };
    }
    case "file.accept":
      return { kind: "file.accept", fileId: requireString(obj, "fileId") };
    case "file.reject":
      return { kind: "file.reject", fileId: requireString(obj, "fileId"), reason: requireString(obj, "reason") };
    case "file.chunk":
      return { kind: "file.chunk", fileId: requireString(obj, "fileId"), index: requireNumber(obj, "index"), totalChunks: requireNumber(obj, "totalChunks"), data: requireString(obj, "data") };
    case "file.ack":
      return { kind: "file.ack", fileId: requireString(obj, "fileId"), index: requireNumber(obj, "index") };
    case "file.nack":
      return { kind: "file.nack", fileId: requireString(obj, "fileId"), index: requireNumber(obj, "index"), reason: requireString(obj, "reason") };
    case "file.pause":
      return { kind: "file.pause", fileId: requireString(obj, "fileId"), reason: requireString(obj, "reason") };
    case "file.resume":
      return { kind: "file.resume", fileId: requireString(obj, "fileId") };
    case "file.cancel":
      return { kind: "file.cancel", fileId: requireString(obj, "fileId"), reason: requireString(obj, "reason") };
    case "file.complete": {
      const sha256 = optionalString(obj, "sha256", "");
      return { kind: "file.complete", fileId: requireString(obj, "fileId"), ...(sha256 ? { sha256 } : {}) };
    }
    case "voice.start": {
      const rawMode = optionalString(obj, "mode", "");
      if (rawMode && rawMode !== "efficient" && rawMode !== "maximum_privacy") {
        throw new Error("Invalid voice mode");
      }

      const mode = rawMode as "" | "efficient" | "maximum_privacy";

      return {
        kind: "voice.start",
        streamId: requireString(obj, "streamId"),
        sampleRate: requireNumber(obj, "sampleRate"),
        frameMs: requireNumber(obj, "frameMs"),
        ...(mode ? { mode } : {})
      };
    }
    case "voice.frame":
      return { kind: "voice.frame", streamId: requireString(obj, "streamId"), seq: requireNumber(obj, "seq"), sentAt: requireNumber(obj, "sentAt"), sampleRate: requireNumber(obj, "sampleRate"), frameMs: requireNumber(obj, "frameMs"), pcm16: requireString(obj, "pcm16") };
    case "voice.stop":
      return { kind: "voice.stop", streamId: requireString(obj, "streamId") };
    default:
      throw new Error("Unknown app message");
  }
}

export function isReliableBody(message: CoreAppMessage): message is ReliableBodyMessage {
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
