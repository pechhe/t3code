import { expect, it } from "@effect/vitest";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
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

// The schema offers one writing role; `lead` and retired names stay callable without being shown.
it("advertises delegate_task's agentTask fields once, offering only the current roles", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.delegate_task) as {
    readonly properties: Readonly<Record<string, unknown>>;
  };
  const agentTask = JSON.stringify(schema.properties.agentTask);
  // One struct (plus the optional-null wrapper), not two copies of the same fields.
  expect(
    agentTask.split('"workspacePath":').length - 1,
    "agentTask fields are advertised once",
  ).toBe(1);
  const offered = /"role":\{"type":"string","allOf":\[\{"enum":(\[[^\]]*\])/.exec(agentTask)?.[1];
  expect(JSON.parse(offered ?? "null")).toEqual([
    "implementer",
    "browser",
    "advisor",
    "reviewer",
    "researcher",
    "scout",
  ]);
  const decode = Schema.decodeUnknownExit(OrchestratorToolkit.tools.delegate_task.parametersSchema);
  for (const role of ["lead", "ui-verifier", "spec-reviewer", "chore-worker", "implementer"])
    expect(
      Exit.isSuccess(
        decode({
          agentTask: {
            role,
            taskClass: "non-ui",
            workId: "w",
            attemptId: "a",
            workspacePath: "/w",
          },
        }),
      ),
      role,
    ).toBe(true);
  expect(
    Exit.isSuccess(
      decode({
        agentTask: {
          role: "lead-ish",
          taskClass: "non-ui",
          workId: "w",
          attemptId: "a",
          workspacePath: "/w",
        },
      }),
    ),
  ).toBe(false);
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

it("refuses a t3_thread_update whose fields do not fit its action", () => {
  const decode = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.t3_thread_update.parametersSchema,
  );
  expect(Exit.isFailure(decode({ action: "rename" }))).toBe(true);
  expect(Exit.isFailure(decode({ action: "regenerate_title", title: "New" }))).toBe(true);
  expect(Exit.isSuccess(decode({ action: "rename", title: "New", environmentId: undefined }))).toBe(
    true,
  );
});

const decodeDelegateTask = Schema.decodeUnknownSync(
  OrchestratorToolkit.tools.delegate_task.parametersSchema,
);
const decodeAgentRoles = Schema.decodeUnknownSync(
  OrchestratorToolkit.tools.agent_roles.parametersSchema,
);

it("accepts and drops the retired demanding flag on delegate_task and agent_roles", () => {
  const delegate = decodeDelegateTask({
    task: "Build it",
    agentTask: {
      role: "implementer",
      taskClass: "non-ui",
      workId: "work",
      attemptId: "1",
      workspacePath: "/repo",
      demanding: true,
    },
  });
  expect(delegate.agentTask).not.toHaveProperty("demanding");
  const roles = decodeAgentRoles({
    taskClass: "non-ui",
    demanding: true,
  });
  expect(roles).not.toHaveProperty("demanding");
});
