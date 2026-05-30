import {
  isTransportProfileId,
  type TransportProfileId,
} from "../config/profiles";
import { normalizeRoomCode } from "../utils/ids";

export interface RoomInfo {
  code: string;
  profileId: TransportProfileId;
}

export async function createRoom(
  profileId: TransportProfileId,
): Promise<RoomInfo> {
  return requestRoom("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId }),
  });
}

export async function lookupRoom(rawCode: string): Promise<RoomInfo> {
  const code = normalizeRoomCode(rawCode);
  if (code.length !== 9) throw new Error("Enter the full room code");
  return requestRoom(`/api/rooms/${encodeURIComponent(code)}`, {
    method: "GET",
  });
}

async function requestRoom(url: string, init: RequestInit): Promise<RoomInfo> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    throw new Error("Could not reach the OnlyTwo relay");
  }

  if (!response.ok) {
    const message = (await response.text()).trim();
    if (response.status === 404) throw new Error("Room not found");
    if (response.status === 429)
      throw new Error("Too many active rooms. Try again later.");
    throw new Error(message || "Room request failed");
  }

  const value = (await response.json()) as Partial<RoomInfo>;
  if (
    typeof value.code !== "string" ||
    normalizeRoomCode(value.code) !== value.code ||
    !isTransportProfileId(value.profileId)
  ) {
    throw new Error("Relay returned invalid room details");
  }
  return { code: value.code, profileId: value.profileId };
}
