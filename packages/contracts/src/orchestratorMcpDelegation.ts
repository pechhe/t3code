import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type AgentTaskRequest, AgentTaskWireRequest } from "./agentPolicy.ts";
import { EnvironmentId, NodeId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  OrchestratorMcpAdviceQuestion,
  OrchestratorMcpClientRequestId,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpTarget,
  OrchestratorMcpUpdateScheduledTaskInput,
} from "./orchestratorMcp.ts";

// The fork's managed-delegation tool inputs, built from upstream's orchestrator MCP schemas.

/** A `delegate_task` input once the server has filled in the task's workspace. */
export type OrchestratorMcpResolvedDelegateTaskInput = Omit<
  OrchestratorMcpDelegateTaskInput,
  "agentTask"
> & { readonly agentTask?: AgentTaskRequest | undefined };

/**
 * The wire form advertises `agentTask` once, offering only the current roles while accepting
 * `lead` and retired names; the handler decodes it with `AgentTaskCallerRequest` before the service sees it.
 */
export const OrchestratorMcpDelegateTaskWireInput = Schema.Struct({
  ...OrchestratorMcpDelegateTaskInput.fields,
  agentTask: Schema.optional(AgentTaskWireRequest),
});
export type OrchestratorMcpDelegateTaskWireInput = typeof OrchestratorMcpDelegateTaskWireInput.Type;

/** Every field is optional: a new advisor defaults to reading the caller's own workspace unpinned. */
const OrchestratorMcpAdviceAdvisor = Schema.Struct({
  workspacePath: Schema.optional(TrimmedNonEmptyString),
  sourceRevision: Schema.optional(TrimmedNonEmptyString),
  workId: Schema.optional(TrimmedNonEmptyString),
  taskId: Schema.optional(NodeId),
  target: Schema.optional(
    Schema.Struct({
      providerInstanceId: OrchestratorMcpTarget.fields.providerInstanceId,
      model: OrchestratorMcpTarget.fields.model,
      options: OrchestratorMcpTarget.fields.options,
    }),
  ),
});

const adviceQuestionInputFields = {
  ...OrchestratorMcpAdviceQuestion.fields,
  evidence: OrchestratorMcpAdviceQuestion.fields.evidence.pipe(
    Schema.withDecodingDefault(Effect.succeed("Not supplied separately.")),
  ),
  recommendation: OrchestratorMcpAdviceQuestion.fields.recommendation.pipe(
    Schema.withDecodingDefault(Effect.succeed("No recommendation supplied.")),
  ),
  blocking: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
};

export const OrchestratorMcpAskAdviceInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("ask"),
    destination: Schema.optional(Schema.Literal("parent")),
    clientRequestId: OrchestratorMcpClientRequestId,
    ...adviceQuestionInputFields,
  }),
  Schema.Struct({
    action: Schema.Literal("ask"),
    destination: Schema.Literal("advisor"),
    clientRequestId: OrchestratorMcpClientRequestId,
    ...adviceQuestionInputFields,
    advisor: Schema.optional(OrchestratorMcpAdviceAdvisor),
  }),
  Schema.Struct({
    action: Schema.Literals(["read", "cancel"]),
    requestId: OrchestratorMcpClientRequestId,
    workerThreadId: Schema.optional(ThreadId),
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  Schema.Struct({
    action: Schema.Literal("answer"),
    requestId: OrchestratorMcpClientRequestId,
    workerThreadId: ThreadId,
    environmentId: OrchestratorMcpEnvironmentTarget,
    answer: TrimmedNonEmptyString.check(Schema.isMaxLength(32_000)),
  }),
]);
export type OrchestratorMcpAskAdviceInput = typeof OrchestratorMcpAskAdviceInput.Type;

export const OrchestratorMcpAskAdviceWireInput = Schema.Struct({
  action: Schema.Literals(["ask", "read", "answer", "cancel"]),
  destination: Schema.optional(Schema.Literals(["parent", "advisor"])),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  requestId: Schema.optional(OrchestratorMcpClientRequestId),
  workerThreadId: Schema.optional(ThreadId),
  // Advice authenticates the parent here before forwarding to its worker.
  environmentId: Schema.optional(EnvironmentId),
  question: Schema.optional(OrchestratorMcpAdviceQuestion.fields.question),
  evidence: Schema.optional(OrchestratorMcpAdviceQuestion.fields.evidence),
  recommendation: Schema.optional(OrchestratorMcpAdviceQuestion.fields.recommendation),
  blocking: Schema.optional(Schema.Boolean),
  followsRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  newEvidence: OrchestratorMcpAdviceQuestion.fields.newEvidence,
  answer: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(32_000))),
  advisor: Schema.optional(OrchestratorMcpAdviceAdvisor),
});

/**
 * The wire form advertises `schedule` compactly: the handler decodes it with
 * `OrchestratorMcpSchedule`, including the compatibility JSON-string shape.
 */
export const OrchestratorMcpScheduleTaskWireInput = Schema.Struct({
  ...OrchestratorMcpScheduleTaskInput.fields,
  schedule: Schema.Unknown.annotate({
    description:
      "Trigger object: {type:'interval', everyMs}, {type:'fixed_time', timeOfDay, weekdays?}, or {type:'webhook'}. Never stringify it unless the provider requires the compatibility form.",
  }),
});
export type OrchestratorMcpScheduleTaskWireInput = typeof OrchestratorMcpScheduleTaskWireInput.Type;

/**
 * The wire form advertises `schedule` without repeating the whole schedule
 * union: `schedule_task` already declares it once, and the handler decodes this
 * object with that same schema.
 */
export const OrchestratorMcpUpdateScheduledTaskWireInput = Schema.Struct({
  ...OrchestratorMcpUpdateScheduledTaskInput.fields,
  schedule: Schema.optional(Schema.Unknown).annotate({
    description: "Replacement schedule, as schedule_task accepts it. Omit to keep the current one.",
  }),
});
export type OrchestratorMcpUpdateScheduledTaskWireInput =
  typeof OrchestratorMcpUpdateScheduledTaskWireInput.Type;
