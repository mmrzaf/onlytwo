export function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected JSON object");
  return parsed as Record<string, unknown>;
}

export function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") throw new Error(`Missing string: ${key}`);
  return value;
}

export function optionalString(obj: Record<string, unknown>, key: string, fallback = ""): string {
  const value = obj[key];
  return typeof value === "string" ? value : fallback;
}

export function requireNumber(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Missing number: ${key}`);
  return value;
}

export function optionalNumber(obj: Record<string, unknown>, key: string, fallback: number): number {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
