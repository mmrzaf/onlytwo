import type { AppMessage } from "../../protocol/appMessages";
import { makeId } from "../../utils/ids";

export function createTextMessage(body: string): Extract<AppMessage, { kind: "text.message" }> {
  return { kind: "text.message", messageId: makeId("msg"), body, createdAt: Date.now() };
}
