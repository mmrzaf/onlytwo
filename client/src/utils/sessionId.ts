export function generateSessionId(): string {
  const arr = new Uint32Array(3);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => n.toString(36))
    .join("")
    .substring(0, 12);
}
