import { describe, expect, it } from "vitest";
import { MAX_TEXT_MESSAGE_CHARS } from "../../protocol/appMessages";
import { createTextMessage } from "./TextService";

describe("createTextMessage", () => {
  it("creates bounded text messages", () => {
    expect(createTextMessage("hello").body).toBe("hello");
    expect(() => createTextMessage("")).toThrow();
    expect(() =>
      createTextMessage("x".repeat(MAX_TEXT_MESSAGE_CHARS + 1)),
    ).toThrow();
  });
});
