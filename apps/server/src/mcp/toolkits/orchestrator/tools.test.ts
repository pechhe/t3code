import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { OrchestratorToolkit } from "./tools.ts";

// Oversized page sizes clamp on decode, so the schema has no `maximum`; Codex also drops
// bounds from its TypeScript view. The description is the only place a model sees a limit.
it("states t3_thread_read page size limits in the parameter descriptions", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.t3_thread_read) as {
    readonly properties: Readonly<Record<string, { readonly description?: string }>>;
  };
  const limits = { limit: "100", runLimit: "50", maxCharsPerItem: "50000" };
  for (const [name, maximum] of Object.entries(limits)) {
    expect(schema.properties[name]?.description, name).toContain(maximum);
  }
});

// The retired `reviewer` role must stay callable without a second copy of every agentTask field
// in the listing: it is one role value, decoded to the reviewer it became (packages/contracts).
it("advertises delegate_task's agentTask fields once, with the retired role as a value", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.delegate_task) as {
    readonly properties: Readonly<Record<string, unknown>>;
  };
  const agentTask = JSON.stringify(schema.properties.agentTask);
  // One struct (plus the optional-null wrapper), not two copies of the same fields.
  expect(
    agentTask.split('"workspacePath":').length - 1,
    "agentTask fields are advertised once",
  ).toBe(1);
  expect(agentTask, "the retired role stays callable").toContain('"reviewer"');
  expect(agentTask, "and still decodes to the reviewer it became").toContain('"spec-reviewer"');
});
