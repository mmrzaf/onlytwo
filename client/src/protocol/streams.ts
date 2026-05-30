import type { AppMessage } from "./appMessages";

export function validateInboundStream(
  message: AppMessage,
  streamId: number,
): void {
  switch (streamId) {
    case 1:
      if (
        message.kind === "reliable.ack" ||
        message.kind === "reliable.nack" ||
        message.kind === "file.ack" ||
        message.kind === "file.nack" ||
        (message.kind === "reliable.msg" &&
          message.channel === "control" &&
          message.body.kind !== "text.message")
      ) {
        return;
      }
      throw new Error("Message kind does not match control stream");
    case 2:
      if (
        message.kind === "reliable.msg" &&
        message.channel === "text" &&
        message.body.kind === "text.message"
      ) {
        return;
      }
      throw new Error("Message kind does not match text stream");
    case 3:
      if (message.kind === "file.chunk") return;
      throw new Error("Message kind does not match file stream");
    case 4:
      if (message.kind === "voice.frame") return;
      throw new Error("Message kind does not match voice stream");
    default:
      throw new Error("Unknown encrypted stream");
  }
}
