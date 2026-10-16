import * as Schema from "effect/Schema";
import { Sha256 } from "./agentPolicy.ts";
import { PositiveInt, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelection } from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadWorkflow } from "./orchestrationV2.ts";

/** A file the agent could read at run start, with its content hash or null when unreadable. */
export const RunSetupFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  sha256: Schema.NullOr(Sha256),
});
export type RunSetupFile = typeof RunSetupFile.Type;

export const RunSetupSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  source: Schema.Literals(["agent-config", "repository"]),
  path: TrimmedNonEmptyString,
  sha256: Schema.NullOr(Sha256),
});
export type RunSetupSkill = typeof RunSetupSkill.Type;

/**
 * The setup a run started with, as T3 observed it just after the run started. Values T3
 * could not observe are null, and a capture that failed outright keeps only the run's
 * model; a run from before capture existed has no record at all.
 */
export const RunSetupRecord = Schema.Struct({
  runId: RunId,
  threadId: ThreadId,
  capturedAt: Schema.String,
  /** The live agent-config checkout (`T3CODE_AGENT_POLICY_ROOT`), read without snapshotting it. */
  agentConfig: Schema.NullOr(
    Schema.Struct({
      root: TrimmedNonEmptyString,
      /** The landed base: the working copy's parent. */
      revision: Schema.NullOr(TrimmedNonEmptyString),
      /** The working-copy commit as of jj's last snapshot. */
      workingCopyRevision: Schema.NullOr(TrimmedNonEmptyString),
      /** Whether the live checkout differs from `revision`, edits not yet snapshotted included. */
      hasLocalChanges: Schema.NullOr(Schema.Boolean),
    }),
  ),
  /** Shared and repository instruction files. */
  instructions: Schema.NullOr(Schema.Array(RunSetupFile)),
  /** Skills available to the agent; which it invoked is read from the run's tool calls. */
  skills: Schema.NullOr(Schema.Array(RunSetupSkill)),
  policy: Schema.NullOr(
    Schema.Struct({ policyHash: Sha256, policyRevision: TrimmedNonEmptyString }),
  ),
  modelSelection: ModelSelection,
  /** Every model option the run used, provider defaults included; null when the model's options are unknown. */
  effectiveOptions: Schema.NullOr(Schema.Array(ProviderOptionSelection)),
  /** The thread's governing workflow and stance, stamped on the run as it started. */
  workflow: Schema.NullOr(OrchestrationV2ThreadWorkflow),
  /**
   * Rollover thresholds in force at run start, bounded by the context window the run's
   * provider session had reported; null when rollover is off.
   */
  rollover: Schema.NullOr(
    Schema.Struct({
      softLimit: PositiveInt,
      hardLimit: PositiveInt,
      held: Schema.Boolean,
      noteRecipe: TrimmedNonEmptyString,
    }),
  ),
  experimentAssignments: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        experimentId: TrimmedNonEmptyString,
        variantId: TrimmedNonEmptyString,
      }),
    ),
  ),
});
export type RunSetupRecord = typeof RunSetupRecord.Type;
