const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function makeId(prefix = "id"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

export function generateRoomCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (const b of bytes) raw += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeRoomCode(value: string): string {
  const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length <= 4) return clean;
  return `${clean.slice(0, 4)}-${clean.slice(4, 8)}`;
}

export function roomCodeFromUrl(): string {
  const room = new URLSearchParams(window.location.search).get("room") ?? "";
  return normalizeRoomCode(room);
}

export function roomLink(code: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", code);
  return url.toString();
}
