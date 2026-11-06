import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { PreviewTaskAction, PreviewTaskTarget } from "./previewTask.ts";

const decodes = (schema: Schema.Top, input: unknown) =>
  Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)(input)._tag === "Success";

const target = { role: "textbox", name: "Message" };

describe("PreviewTaskAction key press", () => {
  it("accepts a listed key, Shift+Tab included, and refuses any other", () => {
    expect(decodes(PreviewTaskAction, { id: "k", press: { key: "Tab", target } })).toBe(true);
    expect(decodes(PreviewTaskAction, { id: "k", press: { key: "Shift+Tab", target } })).toBe(true);
    for (const key of ["Control+W", "F5", "a", "Shift+Enter"])
      expect(decodes(PreviewTaskAction, { id: "k", press: { key, target } })).toBe(false);
  });

  it("reads an action that carries a press as a key press, never as a click", () => {
    const decoded = Schema.decodeUnknownSync(PreviewTaskAction)({
      id: "k",
      target,
      press: { key: "Tab", target },
    });
    expect("press" in decoded && decoded.press.key).toBe("Tab");
  });

  it("is refused by the action variants a server without key presses decodes", () => {
    const withoutKeys = Schema.Union([
      Schema.Struct({ id: Schema.String, target: PreviewTaskTarget }),
      Schema.Struct({ id: Schema.String, url: Schema.String }),
    ]);
    expect(decodes(withoutKeys, { id: "k", press: { key: "Tab", target } })).toBe(false);
  });
});
