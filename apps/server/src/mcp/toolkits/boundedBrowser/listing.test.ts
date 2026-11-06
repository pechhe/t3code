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
  // Measured at 12,053, 12,305 and 14,275 after T3-427's page reach (its origins, avoid list and
  // guidance). A change that needs more states the new number here.
  expect(listed([BoundedBrowserToolkit.tools.t3_browser_task])).toBeLessThan(12_150);
  expect(listed([ManagedBrowserTaskToolkit.tools.preview_task])).toBeLessThan(12_400);
  expect(
    listed([
      ...Object.values(BoundedBrowserToolkit.tools),
      ...Object.values(BoundedBrowserSnapshotToolkit.tools),
    ]),
  ).toBeLessThan(14_400);
});
