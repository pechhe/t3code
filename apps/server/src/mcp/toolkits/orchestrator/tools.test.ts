import { expect, it } from "@effect/vitest";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { Tool } from "effect/ai";

import { OrchestratorToolkit } from "./tools.ts";

// The field the instructions call a follow-up, however they hyphenate it.
const FOLLOWUP = /follow[- ]?up/i;

/** The one sentence naming every token, so the rule can be reworded around them. */
const sentenceStating = (
  where: string,
  text: string,
  ...tokens: ReadonlyArray<string | RegExp>
) => {
  const sentence = text
    .replace(/\s+/g, " ")
    .split(/(?<=\.)\s+/)
    .find((candidate) =>
      tokens.every((token) =>
        typeof token === "string" ? candidate.includes(token) : token.test(candidate),
      ),
    );
  expect(sentence, `${where} states ${tokens.join(" + ")} in one sentence`).toBeDefined();
  return sentence ?? "";
};

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

// A managed task continues in its own conversation, and a review round never continues by
// sending to the child thread. An agent reads the instructions or one description first, so
// an edit to either alone must not leave the other saying the opposite.
it("states the managed-child continuation rule across the instructions and tool descriptions", () => {
  const instructions = T3_CODE_ORCHESTRATION_INSTRUCTIONS;
  const delegateTask = Tool.getDescription(OrchestratorToolkit.tools.delegate_task) ?? "";
  const threadSend = Tool.getDescription(OrchestratorToolkit.tools.t3_thread_send) ?? "";

  // The instructions may only point at a mechanism delegate_task actually offers.
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.delegate_task) as {
    readonly properties: Readonly<Record<string, unknown>>;
  };
  const followup = JSON.stringify(schema.properties.followup);
  expect(followup, "followup takes an earlier taskId").toContain('"taskId"');
  expect(followup, "and continues that managed task").toContain(
    "Continue an owned, idle managed task",
  );

  // Continue a managed task in its own conversation, rather than starting a fresh one.
  sentenceStating(
    "the instructions",
    instructions,
    "managed task",
    "delegate_task",
    FOLLOWUP,
    "fresh",
  );
  sentenceStating("delegate_task", delegateTask, FOLLOWUP, "taskId", "continue");

  // A review round never continues through a thread send, and that tool's own description
  // sends the caller back to the same follow-up the instructions name.
  const forbidden = sentenceStating(
    "the instructions",
    instructions,
    "t3_thread_send",
    "childThreadId",
    "review",
  );
  expect(forbidden, "the review round forbids it").toMatch(/\b(?:Do not|Never)\b/);
  sentenceStating("t3_thread_send", threadSend, "fresh task", "delegate_task", FOLLOWUP);
});
