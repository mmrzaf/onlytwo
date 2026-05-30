import {
  MAX_TEXT_MESSAGE_CHARS,
  type AppMessage,
} from "../../protocol/appMessages";
import { makeId } from "../../utils/ids";

export function createTextMessage(
  body: string,
): Extract<AppMessage, { kind: "text.message" }> {
  if (!body || body.length > MAX_TEXT_MESSAGE_CHARS) {
    throw new Error(
      `Messages must be between 1 and ${MAX_TEXT_MESSAGE_CHARS} characters`,
    );
  }
  return {
    kind: "text.message",
    messageId: makeId("msg"),
    body,
    createdAt: Date.now(),
  };
}
