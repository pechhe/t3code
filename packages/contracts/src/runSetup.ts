import * as Schema from "effect/Schema";
import { Sha256 } from "./agentPolicy.ts";
import {
  NonNegativeInt,
  PositiveInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { AccountBlockReason } from "./accountPools.ts";
import { ProviderOptionSelection } from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";

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

export const RunSetupComposedPrompt = Schema.Struct({
  systemPromptCharacters: NonNegativeInt,
  instructions: Schema.Array(
    Schema.Struct({ path: TrimmedNonEmptyString, characters: NonNegativeInt }),
  ),
  skills: Schema.Array(Schema.Struct({ name: TrimmedNonEmptyString, path: TrimmedNonEmptyString })),
  tools: Schema.Struct({
    count: NonNegativeInt,
    characters: NonNegativeInt,
    declarations: Schema.Array(
      Schema.Struct({ name: TrimmedNonEmptyString, characters: NonNegativeInt }),
    ),
  }),
});
export type RunSetupComposedPrompt = typeof RunSetupComposedPrompt.Type;

/** Most candidates one routing decision records. */
export const RUN_SETUP_ROUTING_MAX_CANDIDATES = 20;

/**
 * One account and model a routing decision could have chosen, as T3 knew it at decision time.
 * Accounts are named by T3's own account id, never by credentials or email.
 */
export const RunSetupRoutingCandidate = Schema.Struct({
  model: TrimmedNonEmptyString,
  instanceId: TrimmedNonEmptyString,
  account: TrimmedNonEmptyString,
  /** False when usage, a reserve or a runtime block held it back. */
  eligible: Schema.Boolean,
  /** `not-preferred` is an eligible candidate ranked below the chosen one. */
  heldBackReason: Schema.optional(
    Schema.Literals(["exhausted", "reserved", "cooldown", "blocked", "not-preferred"]),
  ),
  /** Remaining percent of the governing window with the least left; absent without a reading. */
  remainingPercent: Schema.optional(Schema.Number),
  windowId: Schema.optional(TrimmedNonEmptyString),
  windowKind: Schema.optional(Schema.Literals(["session", "weekly", "monthly", "other"])),
  /** When that window resets, as the reading said then. */
  resetsAt: Schema.optional(Schema.String),
  /** The reset Soonest-reset ranking used: that of the longest governing window. */
  rankingResetsAt: Schema.optional(Schema.String),
  /** When the usage reading was taken, and how old it was at the decision. */
  readingCheckedAt: Schema.optional(Schema.String),
  readingAgeSeconds: Schema.optional(NonNegativeInt),
  /** The in-memory runtime block on the account for the model, when one held it. */
  block: Schema.optional(
    Schema.Struct({
      reason: AccountBlockReason,
      since: Schema.String,
      until: Schema.String,
      reportedReset: Schema.Boolean,
      attempts: NonNegativeInt,
    }),
  ),
});
export type RunSetupRoutingCandidate = typeof RunSetupRoutingCandidate.Type;

/** The routing decision that produced a run's model and account. */
export const RunSetupRouting = Schema.Struct({
  decidedAt: Schema.String,
  /** `both` when a role decision is followed by a pool placement on the same thread (a follow-up on a delegated thread, say); a delegated launch alone is `role-candidates`. */
  kind: Schema.Literals(["role-candidates", "account-pool", "both"]),
  /** The delegated role, when the choice was a role's. */
  role: Schema.optional(TrimmedNonEmptyString),
  /** The caller named the instance or account: not a routing-quality signal. */
  pinned: Schema.Boolean,
  /** The caller named the model, or an experiment's treatment fixed it. */
  modelNamed: Schema.Boolean,
  chosen: Schema.Struct({
    model: TrimmedNonEmptyString,
    instanceId: TrimmedNonEmptyString,
    account: TrimmedNonEmptyString,
  }),
  /** In the order ranked, at most `RUN_SETUP_ROUTING_MAX_CANDIDATES`. */
  candidates: Schema.Array(RunSetupRoutingCandidate),
  /** True when more candidates existed than were kept. */
  truncated: Schema.optional(Schema.Boolean),
});
export type RunSetupRouting = typeof RunSetupRouting.Type;

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
  /** Pi's first request, measured after composing its prompt; null when unreported. */
  composedPrompt: Schema.optional(Schema.NullOr(RunSetupComposedPrompt)),
  /** The live agent-config checkout (`T3CODE_AGENT_POLICY_ROOT`), read without writing to it. */
  agentConfig: Schema.NullOr(
    Schema.Struct({
      root: TrimmedNonEmptyString,
      /** The checkout's HEAD commit, the revision the run was set up from. */
      revision: Schema.NullOr(TrimmedNonEmptyString),
      /** The same HEAD commit: a git checkout keeps edits in the files, not in a commit. */
      workingCopyRevision: Schema.NullOr(TrimmedNonEmptyString),
      /** Whether the checkout has any uncommitted change. */
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
  /** The routing decision behind `modelSelection`; absent when none was recorded or the record predates it. */
  routing: Schema.optional(RunSetupRouting),
  /** Every model option the run used, provider defaults included; null when the model's options are unknown. */
  effectiveOptions: Schema.NullOr(Schema.Array(ProviderOptionSelection)),
  /** Whether Away was on as the run started; absent when capture failed or the record predates it. */
  away: Schema.optional(Schema.Boolean),
  /** Legacy, read-only: older records kept Away here, beside a thread workflow kind T3 dropped. */
  workflow: Schema.optional(Schema.NullOr(Schema.Struct({ unattended: Schema.Boolean }))),
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

const {
  instructions,
  skills,
  runOrdinal: _runOrdinal,
  away: _away,
  workflow: _workflow,
  ...recordFields
} = RunSetupRecord.fields;

/**
 * What `t3_thread_setup` reports for one run: its record with the instruction and skill
 * files reduced to a count and digest, and the full lists only when one run is asked for.
 * A run that never started has no setup, so its setup fields are null.
 */
export const RunSetupReportEntry = Schema.Struct({
  ...recordFields,
  runOrdinal: PositiveInt,
  /** Whether Away was on as the run started; null when unknown. */
  away: Schema.NullOr(Schema.Boolean),
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
