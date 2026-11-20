import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import { ProjectId, ThreadId, TrimmedString } from "@t3tools/contracts";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import { ThemeToolkit } from "./toolkits/theme/tools.ts";

it("keeps descriptions of transformed parameters, such as ids built on TrimmedString", () => {
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: ThreadId.annotate({ description: "Thread." }),
      projectId: Schema.optional(ProjectId.annotate({ description: "Project." })),
      threadIds: Schema.Array(ThreadId.annotate({ description: "One thread." })),
      note: Schema.Struct({ text: TrimmedString.annotate({ description: "Text." }) }),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { type: "string", description: "Thread." },
      projectId: { type: "string", description: "Project." },
      threadIds: { type: "array", items: { type: "string", description: "One thread." } },
      note: {
        type: "object",
        properties: { text: { type: "string", description: "Text." } },
        required: ["text"],
      },
    },
    required: ["threadId", "threadIds", "note"],
  });
});

it("advertises only string enum values, which Gemini requires", () => {
  const enumValues: Array<unknown> = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum" && Array.isArray(value)) enumValues.push(...value);
      else collect(value);
    }
  };
  collect(advertisedJsonSchema(ThemeToolkit.tools.t3_theme_set));

  expect(enumValues.filter((value) => typeof value !== "string")).toEqual([]);
});
