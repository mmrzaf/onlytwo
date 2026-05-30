import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoom, lookupRoom } from "./rooms";

afterEach(() => vi.unstubAllGlobals());

function response(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as Response;
}

describe("room API", () => {
  it("creates a room with the creator-selected immutable profile", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response(201, { code: "ABCD-2345", profileId: "voice_first" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createRoom("voice_first")).resolves.toEqual({
      code: "ABCD-2345",
      profileId: "voice_first",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/rooms",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ profileId: "voice_first" }),
        cache: "no-store",
      }),
    );
  });

  it("looks up an existing room without creating one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response(200, { code: "ABCD-2345", profileId: "maximum_privacy" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(lookupRoom("abcd2345")).resolves.toEqual({
      code: "ABCD-2345",
      profileId: "maximum_privacy",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/rooms/ABCD-2345",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects missing rooms and malformed relay responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(response(404, "room not found")),
    );
    await expect(lookupRoom("ABCD-2345")).rejects.toThrow("Room not found");

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response(200, { code: "ABCD-2345", profileId: "unknown" }),
        ),
    );
    await expect(lookupRoom("ABCD-2345")).rejects.toThrow(
      "Relay returned invalid room details",
    );
  });
});
