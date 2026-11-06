import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
import { ManagedBrowserTaskToolkit } from "../managedBrowser/tools.ts";
import { BoundedBrowserSnapshotToolkit, BoundedBrowserToolkit } from "./tools.ts";

/** What a session pays to list a tool: its description and the schema agents are sent. */
const listed = (tools: ReadonlyArray<Tool.Any>) =>
  tools.reduce(
    (total, tool) =>
      total +
      (Tool.getDescription(tool) ?? "").length +
      JSON.stringify(advertisedJsonSchema(tool)).length,
    0,
  );

it("keeps the bounded browser task tools within their listing budget", () => {
  // Ordered steps, screenshots and inline images took each task tool from about 5,800 and
  // 6,050 characters to 7,279 and 7,510. Key presses (T3-408) took them to 8,367 and 8,598:
  // their target sits under `press`, repeated in the schema, so an older server refuses a key
  // action rather than reading it as a click. A change that needs more states the new number here.
  expect(listed([BoundedBrowserToolkit.tools.t3_browser_task])).toBeLessThan(8_500);
  expect(listed([ManagedBrowserTaskToolkit.tools.preview_task])).toBeLessThan(8_700);
  expect(
    listed([
      ...Object.values(BoundedBrowserToolkit.tools),
      ...Object.values(BoundedBrowserSnapshotToolkit.tools),
    ]),
  ).toBeLessThan(10_600);
});
