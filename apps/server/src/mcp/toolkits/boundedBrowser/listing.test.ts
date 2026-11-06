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
  // Steps and screenshots (T3-413) took the task tools to 7,279 and 7,510, key presses (T3-408,
  // their target under `press` so older servers refuse them) to 8,367 and 8,598, and
  // `nameIncludes` (T3-412, inlined at every target) to 9,043 and 9,274. A change that needs
  // more states the new number here.
  expect(listed([BoundedBrowserToolkit.tools.t3_browser_task])).toBeLessThan(9_150);
  expect(listed([ManagedBrowserTaskToolkit.tools.preview_task])).toBeLessThan(9_400);
  expect(
    listed([
      ...Object.values(BoundedBrowserToolkit.tools),
      ...Object.values(BoundedBrowserSnapshotToolkit.tools),
    ]),
  ).toBeLessThan(11_300);
});
