import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ForwardCompatibleOptional,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderError, SourceControlProviderInfo } from "./sourceControl.ts";
import { VcsDriverKind } from "./vcs.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const GitFilePath = Schema.String.check(Schema.isNonEmpty());
const GIT_LIST_BRANCHES_MAX_LIMIT = 200;

export const GitStackedAction = Schema.Literals([
  "commit",
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
]);
export type GitStackedAction = typeof GitStackedAction.Type;
export const GitActionProgressPhase = Schema.Literals(["branch", "commit", "push", "pr"]);
export type GitActionProgressPhase = typeof GitActionProgressPhase.Type;
export const GitActionProgressKind = Schema.Literals([
  "action_started",
  "phase_started",
  "hook_started",
  "hook_output",
  "hook_finished",
  "action_finished",
  "action_failed",
]);
export type GitActionProgressKind = typeof GitActionProgressKind.Type;
export const GitActionProgressStream = Schema.Literals(["stdout", "stderr"]);
export type GitActionProgressStream = typeof GitActionProgressStream.Type;
const GitCommitStepStatus = Schema.Literals([
  "created",
  "skipped_no_changes",
  "skipped_not_requested",
]);
const GitPushStepStatus = Schema.Literals([
  "pushed",
  "skipped_not_requested",
  "skipped_up_to_date",
]);
const GitBranchStepStatus = Schema.Literals(["created", "skipped_not_requested"]);
const GitPrStepStatus = Schema.Literals(["created", "opened_existing", "skipped_not_requested"]);
const VcsStatusChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPullRequestReference = TrimmedNonEmptyStringSchema;
const GitPullRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPreparePullRequestThreadMode = Schema.Literals(["local", "worktree"]);
export const GitRunStackedActionToastRunAction = Schema.Struct({
  kind: GitStackedAction,
});
export type GitRunStackedActionToastRunAction = typeof GitRunStackedActionToastRunAction.Type;
const GitRunStackedActionToastCta = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("open_pr"),
    label: TrimmedNonEmptyStringSchema,
    url: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("run_action"),
    label: TrimmedNonEmptyStringSchema,
    action: GitRunStackedActionToastRunAction,
  }),
]);
export type GitRunStackedActionToastCta = typeof GitRunStackedActionToastCta.Type;
const GitRunStackedActionToast = Schema.Struct({
  title: TrimmedNonEmptyStringSchema,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  cta: GitRunStackedActionToastCta,
});
export type GitRunStackedActionToast = typeof GitRunStackedActionToast.Type;

export const VcsRef = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  isRemote: Schema.optional(Schema.Boolean),
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  // Full Git ref, for example refs/remotes/origin/feature.
  upstreamRef: Schema.optional(TrimmedNonEmptyStringSchema),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type VcsRef = typeof VcsRef.Type;

const VcsWorktree = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
});
const GitResolvedPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitPullRequestState,
});
export type GitResolvedPullRequest = typeof GitResolvedPullRequest.Type;

export const VcsStatusInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsStatusInput = typeof VcsStatusInput.Type;

export const VcsStatusSubscriptionInput = Schema.Struct({
  ...VcsStatusInput.fields,
  /** Passive observers receive cached remote status without retaining its refresh loop. */
  includeRemote: Schema.optional(Schema.Boolean),
});
export type VcsStatusSubscriptionInput = typeof VcsStatusSubscriptionInput.Type;

export const VcsPullInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsPullInput = typeof VcsPullInput.Type;

export const GitRunStackedActionInput = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
  commitMessage: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000))),
  featureBranch: Schema.optional(Schema.Boolean),
  filePaths: Schema.optional(Schema.Array(GitFilePath).check(Schema.isMinLength(1))),
  threadId: Schema.optional(ThreadId),
  projectId: Schema.optional(ProjectId),
});
export type GitRunStackedActionInput = typeof GitRunStackedActionInput.Type;

export const VcsListRefsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  query: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256))),
  cursor: Schema.optional(NonNegativeInt),
  includeMatchingRemoteRefs: Schema.optional(Schema.Boolean),
  refKind: Schema.optional(Schema.Literals(["all", "local", "remote"])),
  refresh: Schema.optional(Schema.Boolean),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(GIT_LIST_BRANCHES_MAX_LIMIT)),
  ),
});
export type VcsListRefsInput = typeof VcsListRefsInput.Type;

export const VcsCreateWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  newRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  baseRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsCreateWorktreeInput = typeof VcsCreateWorktreeInput.Type;

export const GitPullRequestRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
});
export type GitPullRequestRefInput = typeof GitPullRequestRefInput.Type;

export const GitPreparePullRequestThreadInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  mode: GitPreparePullRequestThreadMode,
  threadId: Schema.optional(ThreadId),
});
export type GitPreparePullRequestThreadInput = typeof GitPreparePullRequestThreadInput.Type;

export const VcsRemoveWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  force: Schema.optional(Schema.Boolean),
});
export type VcsRemoveWorktreeInput = typeof VcsRemoveWorktreeInput.Type;

export const VcsCreateRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  switchRef: Schema.optional(Schema.Boolean),
});
export type VcsCreateRefInput = typeof VcsCreateRefInput.Type;

export const VcsCreateRefResult = Schema.Struct({
  refName: TrimmedNonEmptyStringSchema,
});
export type VcsCreateRefResult = typeof VcsCreateRefResult.Type;

export const VcsSwitchRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
});
export type VcsSwitchRefInput = typeof VcsSwitchRefInput.Type;

export const VcsInitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  kind: Schema.optional(VcsDriverKind),
});
export type VcsInitInput = typeof VcsInitInput.Type;

export const VcsSlipJayLandingLogInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  /** A SlipJay operation id, such as `op_00mv9rf2w1_4e3fcc2f194dee0a482389e6`. */
  operationId: Schema.String.check(Schema.isPattern(/^op_[A-Za-z0-9_]+$/)),
});
export type VcsSlipJayLandingLogInput = typeof VcsSlipJayLandingLogInput.Type;

/** A SlipJay workspace to send to the runner with `slipjay land`. */
export const VcsSlipJayLandInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsSlipJayLandInput = typeof VcsSlipJayLandInput.Type;

// RPC Results

export const VcsSlipJayLandingLogResult = Schema.Struct({
  log: Schema.String,
  /** The log was longer than T3 reads and ends early. */
  truncated: Schema.Boolean,
});
export type VcsSlipJayLandingLogResult = typeof VcsSlipJayLandingLogResult.Type;

/** One command the runner ran for a landing: its dependency install or a gate. */
export const VcsSlipJayLandingCheck = Schema.Struct({
  /** As the project's slipjay.json declares it, which its landing log also shows. */
  command: Schema.String,
  /** SlipJay's purpose, such as `dependencies` or `gate`. */
  purpose: Schema.String,
  /** `passed`, `failed`, or another SlipJay outcome; `running` while it has not finished. */
  outcome: Schema.String,
  durationMs: Schema.optional(Schema.Number),
  failingTests: Schema.Array(Schema.String),
});
export type VcsSlipJayLandingCheck = typeof VcsSlipJayLandingCheck.Type;

/** What the runner recorded of one landing, from `slipjay runner outcome`. */
export const VcsSlipJayLandingDetailResult = Schema.Struct({
  /** SlipJay's status, such as `running`, `landed` or `failed`. */
  status: Schema.String,
  stage: Schema.String,
  /** The landing has finished and will not change. */
  terminal: Schema.Boolean,
  submittedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  /** The workspace that submitted it. */
  workspace: Schema.optional(Schema.String),
  /** The integration commit it landed on, and the commit it published. */
  baseCommitId: Schema.optional(Schema.String),
  commitId: Schema.optional(Schema.String),
  failure: Schema.optional(
    Schema.Struct({ reason: Schema.String, stage: Schema.optional(Schema.String) }),
  ),
  checks: Schema.Array(VcsSlipJayLandingCheck),
});
export type VcsSlipJayLandingDetailResult = typeof VcsSlipJayLandingDetailResult.Type;

export const VcsSlipJayLandResult = Schema.Struct({
  /** This workspace's current change was published. */
  landed: Schema.Boolean,
  /** The followed operation's final status as SlipJay reports it; null when nothing reached the runner. */
  verdict: Schema.NullOr(Schema.String),
  operationId: Schema.NullOr(Schema.String),
  /** The published commit of a landed change. */
  commitId: Schema.NullOr(Schema.String),
  /**
   * SlipJay's own words on the outcome: its failure or refusal, and any change it made to
   * the workspace, such as moving the working copy or keeping the workspace.
   */
  messages: Schema.Array(Schema.String),
});
export type VcsSlipJayLandResult = typeof VcsSlipJayLandResult.Type;

/** A queued SlipJay operation to withdraw with `slipjay cancel`. */
export const VcsSlipJayCancelInput = Schema.Struct({
  operationId: VcsSlipJayLandingLogInput.fields.operationId,
});
export type VcsSlipJayCancelInput = typeof VcsSlipJayCancelInput.Type;

export const VcsSlipJayCancelResult = Schema.Struct({
  /** False when the runner refused, most often because the operation already started. */
  cancelled: Schema.Boolean,
});
export type VcsSlipJayCancelResult = typeof VcsSlipJayCancelResult.Type;

/** An open operation in one of the runner's lanes, as `slipjay watch` reports it. */
export const SlipJayRunnerOperation = Schema.Struct({
  operationId: TrimmedNonEmptyStringSchema,
  /** `landing`, `release`, `deploy` or `reset`. */
  kind: Schema.String,
  /** SlipJay's repository key, lowercase `owner/name`. */
  repo: Schema.String,
  /** `queued` or `running`. */
  status: Schema.String,
  stage: Schema.String,
  /** 1-based place in its lane across repositories; 1 is running or next. */
  position: Schema.optional(Schema.Number),
  submittedAt: Schema.optional(Schema.String),
  /** When a running operation left the queue; absent while it is queued. */
  startedAt: Schema.optional(Schema.String),
  /** When the operation entered its current `stage`. */
  stageStartedAt: Schema.optional(Schema.String),
  /** The runner's median duration of `stage` for this kind of operation; absent without samples. */
  stageMedianMs: Schema.optional(Schema.Number),
  commitId: Schema.optional(Schema.String),
  /** A deploy's environment, such as `staging`. */
  environment: Schema.optional(Schema.String),
  /** The SlipJay workspace on this server's host that submitted it; absent for any other submitter. */
  workspaceName: Schema.optional(Schema.String),
  /** SlipJay's submitter label, such as `host:workspace` or `slipjay-test:schedule`. */
  submittedBy: Schema.String,
});
export type SlipJayRunnerOperation = typeof SlipJayRunnerOperation.Type;

/** A completed deploy of a repository to one environment. */
export const SlipJayRunnerDeploy = Schema.Struct({
  operationId: TrimmedNonEmptyStringSchema,
  repo: Schema.String,
  environment: Schema.String,
  commitId: Schema.String,
  /** `deployed` or `failed`. */
  status: Schema.String,
  finishedAt: Schema.optional(Schema.String),
});
export type SlipJayRunnerDeploy = typeof SlipJayRunnerDeploy.Type;

/** The runner this server follows, from the latest `slipjay watch --json` snapshot. */
export const SlipJayRunnerOverview = Schema.Struct({
  /** False until the watch connects, and while it is reconnecting: the rest is the last known state. */
  connected: Schema.Boolean,
  /** The queue takes no next operation until the owner resumes it. */
  paused: Schema.Boolean,
  /** Landings, releases and resets, in queue order. */
  serial: Schema.Array(SlipJayRunnerOperation),
  /** Deploys, in queue order. */
  deploy: Schema.Array(SlipJayRunnerOperation),
  /** The latest staging deploy of each repository and the recent production deploys, newest first. */
  deploys: Schema.Array(SlipJayRunnerDeploy),
});
export type SlipJayRunnerOverview = typeof SlipJayRunnerOverview.Type;

/** A SlipJay project checkout to plan or confirm a promotion from. */
export const VcsSlipJayPromotionPlanInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsSlipJayPromotionPlanInput = typeof VcsSlipJayPromotionPlanInput.Type;

/** An open Spec the release only partly delivers, as `slipjay promote` warns. */
export const VcsSlipJayHalfBuiltSpec = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  url: Schema.String,
  closedTickets: NonNegativeInt,
  totalTickets: NonNegativeInt,
});

/** `slipjay promote`'s plan, which publishes nothing. */
export const VcsSlipJayPromotionPlan = Schema.Struct({
  /**
   * `planned` when there is a candidate to approve, `up_to_date` when the release branch
   * already holds it, `refused` when SlipJay will not promote from this checkout.
   */
  status: Schema.String,
  /** SlipJay's reason for a refusal. */
  reason: Schema.optional(Schema.String),
  integrationBranch: Schema.optional(Schema.String),
  releaseBranch: Schema.optional(Schema.String),
  /** The commit to approve: the newest one staging deployed. */
  candidate: Schema.optional(Schema.String),
  /** The release branch the candidate is merged onto. */
  base: Schema.optional(Schema.String),
  /** The subjects of the commits it releases, newest first. */
  subjects: Schema.Array(Schema.String),
  /** The release checks the runner runs before it publishes. */
  checks: Schema.Array(Schema.String),
  /** Migration files the runner applies to production before it activates. */
  migrationArtifacts: Schema.Array(Schema.String),
  /** Migrations that drop, rename or rewrite something; a failed deploy is not rolled back. */
  nonAdditiveMigrations: Schema.Array(Schema.String),
  halfBuiltSpecs: Schema.Array(VcsSlipJayHalfBuiltSpec),
});
export type VcsSlipJayPromotionPlan = typeof VcsSlipJayPromotionPlan.Type;

/** The approved candidate to promote with `slipjay promote --confirm`. */
export const VcsSlipJayPromoteInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  candidate: Schema.String.check(Schema.isPattern(/^[0-9a-f]{12,40}$/)),
});
export type VcsSlipJayPromoteInput = typeof VcsSlipJayPromoteInput.Type;

export const VcsSlipJayPromoteResult = Schema.Struct({
  /** The candidate is on the release branch and production deployed it. */
  released: Schema.Boolean,
  /** SlipJay's final status, such as `released`, `failed` or `refused`. */
  status: Schema.String,
  /** SlipJay's own words on why it did not release, or how production ended. */
  messages: Schema.Array(Schema.String),
});
export type VcsSlipJayPromoteResult = typeof VcsSlipJayPromoteResult.Type;

/** A landing check in a SlipJay project's policy: one command the runner runs before landing. */
export const SlipJayLandingCheck = Schema.Struct({
  executable: TrimmedNonEmptyStringSchema,
  args: Schema.Array(Schema.String),
  /** Repository-relative directory it runs in. */
  cwd: Schema.optional(Schema.String),
  /** Runs alongside the checks before it that are also concurrent. */
  concurrent: Schema.optional(Schema.Boolean),
  /** Settings T3 does not edit, kept as declared so saving another field does not drop them. */
  baseline: Schema.optional(Schema.Unknown),
  capability: Schema.optional(Schema.Unknown),
});
export type SlipJayLandingCheck = typeof SlipJayLandingCheck.Type;

/** SlipJay keeps at most this many spare workspaces per project. */
export const SLIPJAY_MAX_SPARES = 8;
const SlipJaySpareCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: SLIPJAY_MAX_SPARES }),
);

/** How much process agents follow on a project: `light` skips reviews, Spec challenges and Tickets. */
export const SlipJayProcessLevel = Schema.Literals(["standard", "light"]);
export type SlipJayProcessLevel = typeof SlipJayProcessLevel.Type;

/** A SlipJay project checkout whose settings to read or change. */
export const VcsSlipJayProjectSettingsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsSlipJayProjectSettingsInput = typeof VcsSlipJayProjectSettingsInput.Type;

/**
 * A SlipJay project's committed policy as `slipjay policy show` reads it from the integration
 * branch, which every machine and agent shares, and this machine's spare limit for it.
 */
export const VcsSlipJayProjectSettings = Schema.Struct({
  integrationBranch: Schema.String,
  /** The integration commit the policy was read from: the base a change must name. */
  revision: Schema.String,
  spares: Schema.Number,
  process: SlipJayProcessLevel,
  requiredLandingVerification: Schema.Array(SlipJayLandingCheck),
  /** Shown only; changed in the file. */
  releaseBranch: Schema.NullOr(Schema.String),
  sharedPaths: Schema.Array(Schema.String),
  generatedPaths: Schema.Array(Schema.String),
  tracker: Schema.String,
  /** This machine's spares for the project: the declared count, lowered by its limit. */
  machineSpares: Schema.Struct({
    machineLimit: Schema.NullOr(Schema.Number),
    effective: Schema.Number,
  }),
});
export type VcsSlipJayProjectSettings = typeof VcsSlipJayProjectSettings.Type;

/** A change to the shared policy, landed by `slipjay policy set` without the landing checks. */
export const VcsSlipJaySetPolicyInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  /** The `revision` the change was made from; a policy that moved since is refused as stale. */
  base: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
  spares: Schema.optional(SlipJaySpareCount),
  process: Schema.optional(SlipJayProcessLevel),
  requiredLandingVerification: Schema.optional(Schema.Array(SlipJayLandingCheck)),
});
export type VcsSlipJaySetPolicyInput = typeof VcsSlipJaySetPolicyInput.Type;

/**
 * `slipjay policy set`'s outcome: `refused` (nothing submitted), `rejected` (nothing changed),
 * `failed-after-integration` (the runner retries publishing) or `uncertain` (saving again reattaches).
 */
export const SlipJayPolicySetPhase = Schema.Literals([
  "landed",
  "already-applied",
  "refused",
  "rejected",
  "failed-after-integration",
  "uncertain",
]);
export type SlipJayPolicySetPhase = typeof SlipJayPolicySetPhase.Type;

export const VcsSlipJayPolicyOutcome = Schema.Struct({
  phase: SlipJayPolicySetPhase,
  /** The integration commit carrying the change, once landed. */
  revision: Schema.NullOr(Schema.String),
  /** Why it did not land. */
  reason: Schema.NullOr(Schema.String),
});
export type VcsSlipJayPolicyOutcome = typeof VcsSlipJayPolicyOutcome.Type;

/**
 * A save returns as soon as the runner has the change, with the operation to follow in the
 * runner's queue; asking again with the same change then waits for its outcome.
 */
export const VcsSlipJayPolicyFollowing = Schema.Struct({
  phase: Schema.Literal("following"),
  operationId: TrimmedNonEmptyStringSchema,
});

export const VcsSlipJaySetPolicyResult = Schema.Union([
  VcsSlipJayPolicyFollowing,
  VcsSlipJayPolicyOutcome,
]);
export type VcsSlipJaySetPolicyResult = typeof VcsSlipJaySetPolicyResult.Type;

/** This machine's spare limit for a project; null removes it. Only lowers the declared count. */
export const VcsSlipJaySetSpareLimitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  limit: Schema.NullOr(SlipJaySpareCount),
});
export type VcsSlipJaySetSpareLimitInput = typeof VcsSlipJaySetSpareLimitInput.Type;

/** The runner this machine lands through, as `slipjay config` reports it. */
export const VcsSlipJayMachineSettings = Schema.Struct({
  /** False on a host without SlipJay: the rest is empty. */
  available: Schema.Boolean,
  /** The location in force, such as `ssh://peach-box` or `http://127.0.0.1:7787`. */
  runner: Schema.NullOr(Schema.String),
  /** The location in SlipJay's machine config file. */
  runnerInFile: Schema.NullOr(Schema.String),
  /** `SLIPJAY_RUNNER` in the server's environment overrides the file. */
  overriddenByEnvironment: Schema.Boolean,
});
export type VcsSlipJayMachineSettings = typeof VcsSlipJayMachineSettings.Type;

/** A runner over SSH, or one on this machine's loopback; null removes the location. */
const LOCAL_RUNNER_PATTERN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
export const SlipJayRunnerLocation = Schema.String.check(
  Schema.isPattern(/^(ssh:\/\/[A-Za-z0-9][A-Za-z0-9.@_-]*|http:\/\/127\.0\.0\.1:\d{1,5})$/),
);
/** A runner on this machine's loopback, rather than one reached over SSH. */
export const isLocalSlipJayRunner = (location: string | null): boolean =>
  location !== null && LOCAL_RUNNER_PATTERN.test(location);
export const VcsSlipJaySetRunnerInput = Schema.Struct({
  location: Schema.NullOr(SlipJayRunnerLocation),
});
export type VcsSlipJaySetRunnerInput = typeof VcsSlipJaySetRunnerInput.Type;

/** Pauses or resumes the runner's queue, for every machine that lands through it. */
export const VcsSlipJayRunnerControlInput = Schema.Struct({
  action: Schema.Literals(["pause", "resume"]),
});
export type VcsSlipJayRunnerControlInput = typeof VcsSlipJayRunnerControlInput.Type;

const VcsStatusChangeRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseRef: TrimmedNonEmptyStringSchema,
  headRef: TrimmedNonEmptyStringSchema,
  state: VcsStatusChangeRequestState,
  isDraft: Schema.optional(Schema.Boolean),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

export const VcsStatusSlipJayLanding = Schema.Struct({
  operationId: TrimmedNonEmptyStringSchema,
  /**
   * `active` while queued or running; otherwise SlipJay's terminal outcome, or
   * `unknown` when the operation left the queue and its outcome could not be read.
   */
  status: Schema.Literals(["active", "landed", "failed", "cancelled", "declined", "unknown"]),
  /** SlipJay's stage name as the runner reports it, e.g. `verifying`. */
  stage: TrimmedNonEmptyStringSchema,
  /** The published commit of a landed change. */
  commitId: Schema.optional(TrimmedNonEmptyStringSchema),
  /** SlipJay's own reason for a failed, cancelled or declined landing. */
  reason: Schema.optional(Schema.String),
  /** False while the runner watch is disconnected, so this is the last reported state. */
  live: Schema.Boolean,
});
export type VcsStatusSlipJayLanding = typeof VcsStatusSlipJayLanding.Type;

const VcsStatusSlipJay = Schema.Struct({
  /**
   * The integration bookmark named by slipjay.json; null when the file cannot be read,
   * or when SlipJay has removed the workspace and only its landing is left to show.
   */
  integration: Schema.NullOr(TrimmedNonEmptyStringSchema),
  /**
   * Whether slipjay.json names a release branch, so a release is possible. Absent on
   * older servers, which clients treat as unknown rather than as no release.
   */
  hasReleaseBranch: Schema.optional(Schema.Boolean),
  /**
   * Which workspace this checkout is, from `slipjay status`; absent when SlipJay cannot
   * say or has removed it, so there is nothing to land.
   */
  workspace: Schema.optional(
    Schema.Struct({
      name: TrimmedNonEmptyStringSchema,
      /** The Issue SlipJay attached to the workspace, if any. */
      issueNumber: Schema.optional(PositiveInt),
      /** The project's integration checkout rather than an allocated workspace. */
      isIntegration: Schema.Boolean,
    }),
  ),
  /** The latest landing of the workspace's change seen on this host, from `slipjay watch`. */
  landing: Schema.optional(VcsStatusSlipJayLanding),
});

const VcsStatusLocalShape = {
  isRepo: Schema.Boolean,
  /**
   * Set when the folder is a repository of another kind, such as Jujutsu, so Git actions,
   * including offering to initialise Git, do not apply. Absent on older servers.
   */
  otherVcsKind: Schema.optional(VcsDriverKind),
  sourceControlProvider: Schema.optional(SourceControlProviderInfo),
  hasPrimaryRemote: Schema.Boolean,
  isDefaultRef: Schema.Boolean,
  refName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    // Absolute worktree root on the environment that every files[].path is
    // relative to. Absent when the server could not resolve it.
    rootPath: Schema.optional(GitFilePath),
    files: Schema.Array(
      Schema.Struct({
        path: GitFilePath,
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
  branchChanges: Schema.optional(
    Schema.Struct({
      baseRef: Schema.NullOr(TrimmedNonEmptyStringSchema),
      insertions: NonNegativeInt,
      deletions: NonNegativeInt,
    }),
  ),
  /**
   * Set when the repository root holds slipjay.json, the same check that makes the server
   * allocate thread workspaces through SlipJay. Absent otherwise and on older servers.
   */
  slipJay: Schema.optional(VcsStatusSlipJay),
};

const VcsStatusRemoteShape = {
  hasUpstream: Schema.Boolean,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  aheadOfDefaultCount: Schema.optional(NonNegativeInt),
  pr: Schema.NullOr(VcsStatusChangeRequest),
};

export const VcsStatusLocalResult = Schema.Struct(VcsStatusLocalShape);
export type VcsStatusLocalResult = typeof VcsStatusLocalResult.Type;

export const VcsStatusRemoteResult = Schema.Struct(VcsStatusRemoteShape);
export type VcsStatusRemoteResult = typeof VcsStatusRemoteResult.Type;

export const VcsStatusResult = Schema.Struct({
  ...VcsStatusLocalShape,
  ...VcsStatusRemoteShape,
});
export type VcsStatusResult = typeof VcsStatusResult.Type;

export const VcsStatusStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    local: VcsStatusLocalResult,
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
  Schema.TaggedStruct("localUpdated", {
    local: VcsStatusLocalResult,
  }),
  Schema.TaggedStruct("remoteUpdated", {
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
]);
export type VcsStatusStreamEvent = typeof VcsStatusStreamEvent.Type;

export const VcsListRefsResult = Schema.Struct({
  isAtRepositoryRoot: Schema.optional(Schema.Boolean),
  refs: Schema.Array(VcsRef),
  isRepo: Schema.Boolean,
  hasPrimaryRemote: Schema.Boolean,
  nextCursor: NonNegativeInt.pipe(Schema.NullOr),
  totalCount: NonNegativeInt,
});
export type VcsListRefsResult = typeof VcsListRefsResult.Type;

export const VcsCreateWorktreeResult = Schema.Struct({
  worktree: VcsWorktree,
});
export type VcsCreateWorktreeResult = typeof VcsCreateWorktreeResult.Type;

export const GitResolvePullRequestResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
});
export type GitResolvePullRequestResult = typeof GitResolvePullRequestResult.Type;

export const GitPreparePullRequestThreadResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
  branch: TrimmedNonEmptyStringSchema,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  /**
   * False when the checkout could not be brought to the pull request head — a reused worktree
   * holding local commits or uncommitted changes keeps its own state, so the code being handed
   * over is older than the pull request.
   */
  isOnPullRequestHead: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
export type GitPreparePullRequestThreadResult = typeof GitPreparePullRequestThreadResult.Type;

export const VcsSwitchRefResult = Schema.Struct({
  refName: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsSwitchRefResult = typeof VcsSwitchRefResult.Type;

export const GitRunStackedActionResult = Schema.Struct({
  action: GitStackedAction,
  branch: Schema.Struct({
    status: GitBranchStepStatus,
    name: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  commit: Schema.Struct({
    status: GitCommitStepStatus,
    commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
    subject: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  push: Schema.Struct({
    status: GitPushStepStatus,
    branch: Schema.optional(TrimmedNonEmptyStringSchema),
    upstreamBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    setUpstream: Schema.optional(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: GitPrStepStatus,
    url: Schema.optional(Schema.String),
    number: Schema.optional(PositiveInt),
    baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    headBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    title: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  toast: GitRunStackedActionToast,
});
export type GitRunStackedActionResult = typeof GitRunStackedActionResult.Type;

export const VcsPullResult = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  refName: TrimmedNonEmptyStringSchema,
  upstreamRef: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type VcsPullResult = typeof VcsPullResult.Type;

// Git stderr can echo credentials from argv and remote URLs. Only a fixed
// reason reaches the error and its diagnostic suffix; newer, unknown reasons
// decode as absent through GitCommandError.
export const GitCommandFailureReason = Schema.Literals([
  "authentication_failed",
  "branch_already_exists",
  "branch_checked_out_in_worktree",
  "host_key_unverified",
  "not_a_repository",
  "path_already_exists",
  "ref_not_found",
  "remote_unreachable",
  "tag_would_be_clobbered",
]);
export type GitCommandFailureReason = typeof GitCommandFailureReason.Type;

export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  argumentCount: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  stdoutLength: Schema.optional(Schema.Number),
  stderrLength: Schema.optional(Schema.Number),
  outputLength: Schema.optional(Schema.Number),
  reason: ForwardCompatibleOptional(GitCommandFailureReason),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const reason = this.reason === undefined ? "" : ` (${this.reason})`;
    return `Git command failed in ${this.operation} (${this.cwd}): ${this.detail}${reason}`;
  }
}

/**
 * A SlipJay command refused or failed. `detail` is a fixed sentence the client can show;
 * SlipJay's own output never goes in it, and a failure underneath stays in `cause`.
 */
export class SlipJayCommandError extends Schema.TaggedError<SlipJayCommandError>()(
  "SlipJayCommandError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class TextGenerationError extends Schema.TaggedError<TextGenerationError>()(
  "TextGenerationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Text generation failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitManagerError extends Schema.TaggedError<GitManagerError>()("GitManagerError", {
  operation: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git manager failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitPullRequestMaterializationError extends Schema.TaggedError<GitPullRequestMaterializationError>()(
  "GitPullRequestMaterializationError",
  {
    cwd: TrimmedNonEmptyStringSchema,
    pullRequestNumber: PositiveInt,
    headRepository: Schema.NullOr(TrimmedNonEmptyStringSchema),
    headBranch: TrimmedNonEmptyStringSchema,
    localBranch: TrimmedNonEmptyStringSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to materialize pull request #${this.pullRequestNumber} branch ${this.headBranch} as ${this.localBranch}.`;
  }
}

export const GitManagerServiceError = Schema.Union([
  GitManagerError,
  GitPullRequestMaterializationError,
  GitCommandError,
  SourceControlProviderError,
  TextGenerationError,
]);
export type GitManagerServiceError = typeof GitManagerServiceError.Type;

const GitActionProgressBase = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
});

const GitActionStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_started"),
  phases: Schema.Array(GitActionProgressPhase),
});
const GitActionPhaseStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("phase_started"),
  phase: GitActionProgressPhase,
  label: TrimmedNonEmptyStringSchema,
});
const GitActionHookStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_started"),
  hookName: TrimmedNonEmptyStringSchema,
});
const GitActionHookOutputEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_output"),
  hookName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  stream: GitActionProgressStream,
  text: TrimmedNonEmptyStringSchema,
});
const GitActionHookFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_finished"),
  hookName: TrimmedNonEmptyStringSchema,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(NonNegativeInt),
});
const GitActionFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_finished"),
  result: GitRunStackedActionResult,
});
const GitActionFailedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_failed"),
  phase: Schema.NullOr(GitActionProgressPhase),
  message: TrimmedNonEmptyStringSchema,
});

export const GitActionProgressEvent = Schema.Union([
  GitActionStartedEvent,
  GitActionPhaseStartedEvent,
  GitActionHookStartedEvent,
  GitActionHookOutputEvent,
  GitActionHookFinishedEvent,
  GitActionFinishedEvent,
  GitActionFailedEvent,
]);
export type GitActionProgressEvent = typeof GitActionProgressEvent.Type;
