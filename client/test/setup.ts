import { vi } from "vitest";

Object.defineProperty(globalThis, "crypto", {
  value: globalThis.crypto ?? {
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
    getRandomValues: (arr: Uint8Array) => arr.fill(7)
  },
  configurable: true
});

vi.stubGlobal("scrollTo", () => undefined);
