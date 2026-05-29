import type { TransportProfile } from "../../config/profiles";
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, sha256 } from "../../utils/bytes";

export interface CompletedFile {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  blob: Blob;
}

export function validateFilename(name: string): string {
  const clean = name.replace(/[\\/?%*:|"<>]/g, "_").slice(0, 180).trim();
  return clean || "download";
}

export function validateOutboundFile(file: File, profile: TransportProfile): void {
  if (file.size <= 0) throw new Error("Empty files are not supported");
  if (file.size > profile.files.maxFileBytes) throw new Error(`File is larger than this profile allows`);
  if (file.name.length > 180) throw new Error("Filename is too long");
}

export function encodeChunk(bytes: Uint8Array): string { return bytesToBase64Url(bytes); }
export function decodeChunk(value: string): Uint8Array { return base64UrlToBytes(value); }

export async function digestBytes(bytes: Uint8Array): Promise<string> { return bytesToHex(await sha256(bytes)); }
export async function digestBlob(blob: Blob): Promise<string> { return digestBytes(new Uint8Array(await blob.arrayBuffer())); }
