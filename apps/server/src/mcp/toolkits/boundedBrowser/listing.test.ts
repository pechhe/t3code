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
  // Measured at 11,072 and 11,324 after T3-426's role-alone, text and hinted targets and saved
  // logins. A change that needs more states the new number here.
  expect(listed([BoundedBrowserToolkit.tools.t3_browser_task])).toBeLessThan(11_150);
  expect(listed([ManagedBrowserTaskToolkit.tools.preview_task])).toBeLessThan(11_400);
  expect(
    listed([
      ...Object.values(BoundedBrowserToolkit.tools),
      ...Object.values(BoundedBrowserSnapshotToolkit.tools),
    ]),
  ).toBeLessThan(13_400);
});
