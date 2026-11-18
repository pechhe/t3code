import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import { ProjectId, ThreadId, TrimmedString } from "@t3tools/contracts";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";

it("drops JSON noise, merges tagged unions, flattens check fragments, and keeps null where it is required", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      // Accepts more than it advertises, as delegate_task's role does.
      role: Schema.String.check(
        Schema.makeFilter((value: string) => value.length > 0, {
          toJsonSchema: () => ({ enum: ["offered"] }),
        }),
      ),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { type: "string" },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      limit: { type: "integer" },
      role: { type: "string", enum: ["offered"] },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["url", "number"] },
          url: { type: "string" },
          number: { type: "integer" },
        },
        required: ["kind"],
      },
    },
    required: ["beforeRunId", "role", "every"],
  });
});

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
