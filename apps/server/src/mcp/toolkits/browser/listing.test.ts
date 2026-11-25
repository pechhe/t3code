import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
import { BrowserSnapshotToolkit, BrowserToolkit } from "./tools.ts";

/** What a session pays to list a tool: its description and the schema agents are sent. */
const listed = (tools: ReadonlyArray<Tool.Any>) =>
  tools.reduce(
    (total, tool) =>
      total +
      (Tool.getDescription(tool) ?? "").length +
      JSON.stringify(advertisedJsonSchema(tool)).length,
    0,
  );

it("keeps the browser tools within their listing budget", () => {
  // T3-571's guarded ordinal repeats at every target: task 16,513. T3-853: one family of 25,675
  // replaces the bounded tools (19,188) and the preview and preview-control tools (14,153).
  // YS-2419: browser_page_tools adds ~0.75K to the family (26,020).
  expect(listed([BrowserToolkit.tools.browser_task])).toBeLessThan(16_600);
  expect(
    listed([
      ...Object.values(BrowserToolkit.tools),
      ...Object.values(BrowserSnapshotToolkit.tools),
    ]),
  ).toBeLessThan(26_100);
});
