import * as Schema from "effect/Schema";
import { Sha256 } from "./agentPolicy.ts";
import {
  NonNegativeInt,
  PositiveInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderOptionSelection } from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2RunStatus, OrchestrationV2ThreadWorkflow } from "./orchestrationV2.ts";

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
  /** The run's ordinal in its thread, which orders records; absent from early records. */
  runOrdinal: Schema.optional(PositiveInt),
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
  /** Legacy, read-only: rollover thresholds recorded by the removed context rollover. */
  rollover: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        softLimit: PositiveInt,
        hardLimit: PositiveInt,
        held: Schema.Boolean,
        noteRecipe: TrimmedNonEmptyString,
      }),
    ),
  ),
  /**
   * The instruction experiment variant delivered to the run, named by its hash; null when
   * the run received none, absent when unknown (capture failed or predates the lever).
   */
  instructionOverlay: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        experimentId: TrimmedNonEmptyString,
        variantId: TrimmedNonEmptyString,
        sourcePath: TrimmedNonEmptyString,
        revision: TrimmedNonEmptyString,
        sha256: Sha256,
      }),
    ),
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

/** A file list reduced to its size and one digest of every path and content hash in it. */
export const RunSetupFileSummary = Schema.Struct({
  count: NonNegativeInt,
  digest: Sha256,
});
export type RunSetupFileSummary = typeof RunSetupFileSummary.Type;

const { instructions, skills, runOrdinal: _runOrdinal, ...recordFields } = RunSetupRecord.fields;

/**
 * What `t3_thread_setup` reports for one run: its record with the instruction and skill
 * files reduced to a count and digest, and the full lists only when one run is asked for.
 * A run that never started has no setup, so its setup fields are null.
 */
export const RunSetupReportEntry = Schema.Struct({
  ...recordFields,
  runOrdinal: PositiveInt,
  /** The driver kind behind the run's provider instance; null when the instance is unknown. */
  driver: Schema.NullOr(Schema.String),
  status: OrchestrationV2RunStatus,
  startedAt: Schema.NullOr(Schema.String),
  instructionSummary: Schema.NullOr(RunSetupFileSummary),
  skillSummary: Schema.NullOr(RunSetupFileSummary),
  instructions: Schema.optional(instructions),
  skills: Schema.optional(skills),
  /** Null for providers that do not report skill loads. */
  invokedSkills: Schema.NullOr(Schema.Array(Schema.String)),
});
export type RunSetupReportEntry = typeof RunSetupReportEntry.Type;
