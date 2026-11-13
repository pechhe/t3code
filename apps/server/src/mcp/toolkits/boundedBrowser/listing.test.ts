import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
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
  // T3-571's guarded ordinal repeats at every target: task 16,348; full family 19,025.
  expect(listed([BoundedBrowserToolkit.tools.t3_browser_task])).toBeLessThan(16_450);
  expect(
    listed([
      ...Object.values(BoundedBrowserToolkit.tools),
      ...Object.values(BoundedBrowserSnapshotToolkit.tools),
    ]),
  ).toBeLessThan(19_150);
});
