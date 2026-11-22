import * as Schema from "effect/Schema";

import {
  AgentRole,
  AgentTaskBinding,
  AgentTaskCallerRequest,
  AgentTaskHandoff,
  StoredAgentRole,
} from "./agentPolicy.ts";
import { NodeId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ForgeItemReferenceInput } from "./forgeWorkItem.ts";
import { ModelSelection } from "./modelSelection.ts";

// The fork's managed-delegation fields on upstream's orchestrator MCP schemas. orchestratorMcp.ts
// spreads them in place, so this module must not import it.

export const managedDelegateTaskInputFields = {
  externalSessionKey: Schema.optional(TrimmedNonEmptyString),
  agentTask: Schema.optional(AgentTaskCallerRequest),
  followup: Schema.optional(
    Schema.Struct({
      taskId: NodeId,
      sourceRevision: Schema.optional(TrimmedNonEmptyString),
      changes: TrimmedNonEmptyString.check(Schema.isMaxLength(10_000)),
    }).annotate({
      description:
        "Continue an owned, idle managed task in its existing conversation, workspace, model and permissions: taskId is any earlier ID, changes say what happened since, sourceRevision pins the revision. Pass no agentTask, target, isolation or mode.",
    }),
  ),
  offPolicyReason: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))).annotate({
    description: "Rare fallback: why no policy role or model fits.",
  }),
};

export const forgeItemField = {
  forgeItem: Schema.optional(ForgeItemReferenceInput).annotate({
    description:
      "Top-level threads only: a Forge Spec (number or ref) the `implementer` owns in its own workspace and lands.",
  }),
};

export const managedDelegateTaskResultFields = {
  launchState: Schema.optional(
    Schema.Literals(["prepared", "accepted", "cancelled", "launch-unknown", "refused"]),
  ),
  failureReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  assignmentIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  agentTask: Schema.optional(AgentTaskBinding),
  /** Present once an isolated scoped-write task has finished. */
  handoff: Schema.optional(AgentTaskHandoff),
};

export const pausedByParentStopField = {
  pausedByParentStop: Schema.optional(Schema.Literal(true)).annotate({
    description:
      "Stopping its parent thread interrupted it. The parent's next message from a person continues it as a new task, so do not delegate it again.",
  }),
};

/**
 * A Spec review sat as a council: every member's task, and the makers that could not sit. For a
 * Forge Spec the lead records the roster with `weave_forge_council`, naming each member's
 * `taskRef` (never its `taskId`) and this round's clientRequestId as `clientRef`.
 */
export const OrchestratorMcpReviewCouncil = Schema.Struct({
  /** False when fewer than two makers could sit, so one reviewer runs instead. */
  formed: Schema.Boolean,
  members: Schema.Array(
    Schema.Struct({
      maker: TrimmedNonEmptyString,
      /** What the member records as `review.reviewer.taskRef`, and the roster names. */
      taskRef: TrimmedNonEmptyString,
      taskId: NodeId,
      model: Schema.NullOr(Schema.String),
    }),
  ),
  missing: Schema.Array(
    Schema.Struct({
      maker: TrimmedNonEmptyString,
      model: TrimmedNonEmptyString,
      reason: TrimmedNonEmptyString,
    }),
  ),
});
export type OrchestratorMcpReviewCouncil = typeof OrchestratorMcpReviewCouncil.Type;

export const councilField = {
  /** A Spec review the policy sits as a council; the fields above are its first member's. */
  council: Schema.optional(OrchestratorMcpReviewCouncil),
};

export const whyNotDelegatedField = {
  whyNotDelegated: Schema.optional(
    Schema.String.annotate({
      description:
        "Required inside a thread: one sentence on why these must be separate top-level threads rather than `delegate_task` children.",
    }),
  ),
};

export const scheduleTaskRoleFields = {
  agentRole: Schema.optional(Schema.NullOr(StoredAgentRole)).annotate({
    description:
      "Role whose policy picks the model at each run. Defaults to 'implementer' unless modelSelection is explicit. Cannot combine a role with modelSelection.",
  }),
  modelSelection: Schema.optional(ModelSelection).annotate({
    description:
      "Explicit provider, model and options for new runs instead of a role. Creates an unbound task by default; a bound task follows its thread's model.",
  }),
};

export const scheduledTaskRoleFields = {
  agentRole: Schema.NullOr(AgentRole).annotate({
    description:
      "Subagent role this task runs as; its policy picks the model. Null for an explicit model or a legacy task saved before roles.",
  }),
  modelSelection: Schema.optional(ModelSelection),
};

export const updateScheduledTaskRoleFields = {
  agentRole: Schema.optional(Schema.NullOr(StoredAgentRole)).annotate({
    description:
      "A role switches to role selection; null keeps the saved model as the task's model. Cannot combine a role with modelSelection. Omit both to keep the current choice.",
  }),
  modelSelection: Schema.optional(ModelSelection).annotate({
    description:
      "Replace the saved model and switch off role selection. A bound task must also set bindToCurrentThread:false. Omit to keep the current choice.",
  }),
};
