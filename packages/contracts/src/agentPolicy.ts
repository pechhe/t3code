import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { EnvironmentId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ModelSelection } from "./modelSelection.ts";

export const AgentRole = Schema.Literals([
  "chore-worker",
  "implementation-worker",
  "ui-worker",
  "browser",
  "ui-verifier",
  "advisor",
  "ticket-reviewer",
  "spec-reviewer",
  "researcher",
  "scout",
]);
export type AgentRole = typeof AgentRole.Type;
/** How a managed task's thread title names its role: `<label> · <topic>`. */
export const AGENT_ROLE_TITLE_LABEL = {
  "chore-worker": "Chore worker",
  "implementation-worker": "Implementation worker",
  "ui-worker": "UI worker",
  browser: "Browser",
  "ui-verifier": "UI verifier",
  advisor: "Advisor",
  "ticket-reviewer": "Ticket reviewer",
  "spec-reviewer": "Spec reviewer",
  researcher: "Researcher",
  scout: "Scout",
} as const satisfies Record<AgentRole, string>;
/**
 * A managed task's title without its role prefix, for places that already show the role as
 * a chip. Empty when the title names only the role; unchanged when it lacks the prefix.
 */
export const agentTaskTopic = (title: string, role: AgentRole): string => {
  const label = AGENT_ROLE_TITLE_LABEL[role];
  if (title === label) return "";
  return title.startsWith(`${label} · `) ? title.slice(label.length + 3) : title;
};
/** The roles that judge pinned work: fresh-context, read-only and scoped by `review`. */
export const isReviewerRole = (role: AgentRole) =>
  role === "ticket-reviewer" || role === "spec-reviewer";
/** The read-only roles that answer the lead's questions rather than produce work. */
export const isConsultingRole = (role: AgentRole) =>
  role === "advisor" || role === "researcher" || role === "scout";
/** The review scope each reviewer role judges. */
export const REVIEWER_SCOPE = {
  "ticket-reviewer": "change",
  "spec-reviewer": "spec",
} as const;
/**
 * The coarse kind that trials, categories and reports already group delegated work by. The
 * canonical role is carried beside it, never in its place.
 */
export const AGENT_ROLE_COARSE_KIND = {
  "chore-worker": "implementation",
  "implementation-worker": "implementation",
  "ui-worker": "design",
  browser: "test",
  "ui-verifier": "test",
  advisor: "research",
  "ticket-reviewer": "review",
  "spec-reviewer": "review",
  researcher: "research",
  scout: "research",
} as const satisfies Record<AgentRole, string>;

export const AgentTaskClass = Schema.Literals(["non-ui", "ui", "mixed"]);
export type AgentTaskClass = typeof AgentTaskClass.Type;

const Alias = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));
const Aliases = Schema.Array(Alias).check(
  Schema.makeFilter((values) => new Set(values).size === values.length),
);
const BriefPath = TrimmedNonEmptyString.check(Schema.isPattern(/^roles\/[a-z][a-z0-9-]*\.md$/));
const SourceAccess = Schema.Literals(["read-only", "scoped-write"]);
/**
 * `web-research` reads source like `source-reader` and may also search and fetch the web.
 * `phi` reads source and drives Phi; `implementation-phi` is a writer that also drives Phi.
 */
export const AgentToolProfile = Schema.Literals([
  "source-reader",
  "implementation",
  "phi",
  "implementation-phi",
  "web-research",
]);
export type AgentToolProfile = typeof AgentToolProfile.Type;
/** Whether a task with this profile gets its own Phi browser endpoint. */
export const usesPhi = (profile: AgentToolProfile | undefined) =>
  profile === "phi" || profile === "implementation-phi";
/** The profile a role runs with when a task narrows it to read-only: it loses writing, not Phi. */
export const readOnlyToolProfile = (profile: AgentToolProfile): AgentToolProfile =>
  profile === "implementation"
    ? "source-reader"
    : profile === "implementation-phi"
      ? "phi"
      : profile;
const ModelBinding = Schema.Struct({
  driverKind: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  /** The select option carrying effort; absent for a model that has no effort setting. */
  effortOption: Schema.optional(TrimmedNonEmptyString),
  /** Select options every task on this model carries beside effort, e.g. `serviceTier: "fast"`. */
  options: Schema.optional(Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString)),
});

/** A model a role may use and, when the model has one, the effort it runs at. */
export const AgentListEntry = Schema.Struct({
  model: Alias,
  effort: Schema.optional(TrimmedNonEmptyString),
});
export type AgentListEntry = typeof AgentListEntry.Type;
const RolePolicy = Schema.Struct({
  /** The ordered model list this role uses; roles naming the same list share it. */
  list: Alias,
  brief: BriefPath,
  sourceAccess: SourceAccess,
  toolProfile: AgentToolProfile,
  taskClasses: Schema.Array(AgentTaskClass).check(Schema.isMinLength(1)),
  /** A large (`demanding`) task starts with this model, at this effort. */
  large: Schema.optional(AgentListEntry),
  /** The model alias an asking agent runs, mapped to the model it starts with instead. */
  callers: Schema.optional(Schema.Record(Alias, Alias)),
  /** Reviewer roles: prefer a provider other than the author's. */
  preferOtherAuthorProvider: Schema.optional(Schema.Boolean),
});

/**
 * One entry per role. `researcher` and `scout` were added after policies and task snapshots
 * were saved, so a policy may leave them out; such a role is then unavailable.
 */
const rolesRecord = <S extends Schema.Top>(entry: S) =>
  Schema.Struct({
    "chore-worker": entry,
    "implementation-worker": entry,
    "ui-worker": entry,
    browser: entry,
    "ui-verifier": entry,
    advisor: entry,
    "ticket-reviewer": entry,
    "spec-reviewer": entry,
    researcher: Schema.optionalKey(entry),
    scout: Schema.optionalKey(entry),
  });

const Manifest = Schema.Struct({
  version: Schema.Literal(2),
  revision: TrimmedNonEmptyString,
  models: Schema.Record(Alias, ModelBinding),
  /** Each list orders the models a role may use; the first available one is the default. */
  lists: Schema.Record(Alias, Schema.Array(AgentListEntry).check(Schema.isMinLength(1))),
  roles: rolesRecord(RolePolicy),
});

/** Structural authority is fixed; model identities and order belong to the versioned policy. */
function validManifest(manifest: typeof Manifest.Type): boolean {
  const { lists, models, roles } = manifest;
  // A model's effort is present exactly when the model exposes one, so a list cannot drop
  // it, or keep a stale value after the model loses its effort setting.
  const hasEffort = (entry: { readonly model: string; readonly effort?: string | undefined }) =>
    (models[entry.model]?.effortOption !== undefined) === (entry.effort !== undefined);
  for (const list of Object.values(lists)) {
    const aliases = list.map((entry) => entry.model);
    if (new Set(aliases).size !== aliases.length) return false;
    if (aliases.some((alias) => models[alias] === undefined)) return false;
    if (!list.every(hasEffort)) return false;
  }
  for (const [name, role] of Object.entries(roles)) {
    if (role === undefined) continue;
    if (role.toolProfile === "web-research" && role.sourceAccess !== "read-only") return false;
    // Only UI work both writes source and drives a browser, to check what it built.
    if (
      role.toolProfile === "implementation-phi" &&
      (name !== "ui-worker" || role.sourceAccess !== "scoped-write")
    )
      return false;
    const list = lists[role.list]?.map((entry) => entry.model);
    if (list === undefined || role.brief !== `roles/${name}.md`) return false;
    if (role.large !== undefined && !list.includes(role.large.model)) return false;
    if (role.large !== undefined && !hasEffort(role.large)) return false;
    for (const [caller, first] of Object.entries(role.callers ?? {}))
      if (models[caller] === undefined || !list.includes(first)) return false;
    if (role.preferOtherAuthorProvider !== undefined && !isReviewerRole(name as AgentRole))
      return false;
  }
  const readOnly = (role: (typeof roles)[AgentRole], toolProfile: string) =>
    role?.sourceAccess === "read-only" && role.toolProfile === toolProfile;
  return (
    (roles.researcher === undefined || readOnly(roles.researcher, "web-research")) &&
    (roles.scout === undefined || readOnly(roles.scout, "source-reader")) &&
    readOnly(roles.browser, "phi") &&
    readOnly(roles["ui-verifier"], "phi") &&
    [roles["ticket-reviewer"], roles["spec-reviewer"], roles.advisor].every((role) =>
      readOnly(role, "source-reader"),
    ) &&
    [roles["chore-worker"], roles["implementation-worker"]].every(
      (role) =>
        role.taskClasses.length === 1 &&
        role.taskClasses[0] === "non-ui" &&
        role.toolProfile === "implementation",
    )
  );
}
const CurrentManifest = Manifest.check(Schema.makeFilter(validManifest));

/**
 * Version 1 kept fixed pools, per-class restrictions and per-role effort. Saved task
 * snapshots and an unconverted `roles/policy.json` still carry it; it decodes to the
 * same treatment as one list per role, and is never written.
 */
const LegacyRole = Schema.Literals([
  "chore-worker",
  "implementation-worker",
  "ui-worker",
  "browser",
  "ui-verifier",
  "advisor",
  "reviewer",
]);
const LegacyPool = Schema.Literals(["fast", "workhorse", "ui", "advisor"]);
const LegacyManifest = Schema.Struct({
  version: Schema.Literal(1),
  revision: TrimmedNonEmptyString,
  models: Schema.Record(Alias, ModelBinding),
  pools: Schema.Record(
    LegacyPool,
    Schema.Struct({
      allow: Aliases,
      prefer: Aliases,
      crossProvider: Schema.optional(Schema.Boolean),
    }),
  ),
  roles: Schema.Record(
    LegacyRole,
    Schema.Struct({
      pool: LegacyPool,
      brief: BriefPath,
      sourceAccess: SourceAccess,
      toolProfile: AgentToolProfile,
      taskClasses: Schema.Array(AgentTaskClass),
      restrictions: Schema.Struct({
        "non-ui": Schema.optional(Aliases),
        ui: Schema.optional(Aliases),
        mixed: Schema.optional(Aliases),
      }),
      effort: Schema.Record(
        Alias,
        Schema.Struct({
          default: TrimmedNonEmptyString,
          demanding: Schema.optional(TrimmedNonEmptyString),
        }),
      ),
    }),
  ),
  reviewer: Schema.optional(
    Schema.Struct({ prefer: Aliases, requireDifferentProvider: Schema.Boolean }),
  ),
});
const upgradeManifest = (legacy: typeof LegacyManifest.Type): typeof Manifest.Encoded => {
  const lists: Record<string, Array<AgentListEntry>> = {};
  const roles: Record<string, typeof RolePolicy.Encoded> = {};
  for (const [legacyName, role] of Object.entries(legacy.roles)) {
    const pool = legacy.pools[role.pool];
    const prefer =
      legacyName === "reviewer" ? (legacy.reviewer?.prefer ?? pool.prefer) : pool.prefer;
    const restricted = role.taskClasses.every((kind) => role.restrictions[kind] !== undefined)
      ? new Set(role.taskClasses.flatMap((kind) => role.restrictions[kind] ?? []))
      : undefined;
    const order = [...prefer, ...pool.allow.filter((alias) => !prefer.includes(alias))].filter(
      (alias) =>
        pool.allow.includes(alias) && role.effort[alias] && restricted?.has(alias) !== false,
    );
    const large = order.find((alias) => role.effort[alias]!.demanding !== undefined);
    const names: ReadonlyArray<AgentRole> =
      legacyName === "reviewer" ? ["ticket-reviewer", "spec-reviewer"] : [legacyName as AgentRole];
    for (const name of names) {
      lists[name] = order.map((model) => ({ model, effort: role.effort[model]!.default }));
      roles[name] = {
        list: name,
        brief: `roles/${name}.md`,
        sourceAccess: role.sourceAccess,
        toolProfile: role.toolProfile,
        taskClasses: role.taskClasses,
        ...(large === undefined
          ? {}
          : { large: { model: large, effort: role.effort[large]!.demanding! } }),
        ...(isReviewerRole(name)
          ? { preferOtherAuthorProvider: legacy.reviewer?.requireDifferentProvider ?? false }
          : {}),
      };
    }
  }
  return {
    version: 2,
    revision: legacy.revision,
    models: legacy.models,
    lists,
    roles: roles as (typeof Manifest.Encoded)["roles"],
  };
};
export const AgentPolicyManifest = Schema.Union([
  CurrentManifest,
  LegacyManifest.pipe(
    Schema.decodeTo(CurrentManifest, {
      decode: SchemaGetter.transform(upgradeManifest),
      encode: SchemaGetter.forbidden(() => "Version 1 policies are never written."),
    }),
  ),
]);
export type AgentPolicyManifest = typeof AgentPolicyManifest.Type;
export const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Brief = Schema.Struct({
  hash: Sha256,
  // Keep the exact bytes represented by the brief hash, including trailing newlines.
  text: Schema.String.check(Schema.makeFilter((text) => text.trim().length > 0)),
});
const Snapshot = Schema.Struct({
  hash: Sha256,
  sourceRevision: TrimmedNonEmptyString,
  manifest: AgentPolicyManifest,
  briefs: rolesRecord(Brief),
});
export const AgentPolicySnapshot = Schema.Union([
  Snapshot,
  // Snapshots stored before the reviewer split; both reviewers read the old brief.
  Schema.Struct({
    hash: Sha256,
    sourceRevision: TrimmedNonEmptyString,
    manifest: LegacyManifest,
    briefs: Schema.Record(LegacyRole, Brief),
  }).pipe(
    Schema.decodeTo(Snapshot, {
      decode: SchemaGetter.transform(({ briefs: { reviewer, ...briefs }, ...snapshot }) => ({
        ...snapshot,
        manifest: upgradeManifest(snapshot.manifest),
        briefs: { ...briefs, "ticket-reviewer": reviewer, "spec-reviewer": reviewer },
      })),
      encode: SchemaGetter.forbidden(() => "Version 1 snapshots are never written."),
    }),
  ),
]);
export type AgentPolicySnapshot = typeof AgentPolicySnapshot.Type;

/**
 * `lead` runs in the caller's own workspace. `isolated` runs a simultaneous helper in a
 * separate registered workspace of the same repository, allocated outside T3 (SlipJay).
 */
export const AgentWorkspaceAssignment = Schema.Literals(["lead", "isolated"]);
export type AgentWorkspaceAssignment = typeof AgentWorkspaceAssignment.Type;

/**
 * What a review judges: a candidate change (one landing, possibly serving several Tickets)
 * for `ticket-reviewer`, or a Spec's integrated outcome across its slices for `spec-reviewer`.
 */
export const AgentReviewScope = Schema.Literals(["change", "spec"]);
export type AgentReviewScope = typeof AgentReviewScope.Type;
export const AgentReviewRequest = Schema.Struct({
  scope: AgentReviewScope,
  /** The candidate is the task's pinned `sourceRevision`; this is what it is compared with. */
  baseRevision: TrimmedNonEmptyString,
  /** Commits or landings attributed to the reviewed work; interleaved unrelated ones are excluded. */
  includedChanges: Schema.Array(TrimmedNonEmptyString),
  /** The Spec judged, such as `owner/repo#12`, and the body revision read. Required for Spec scope. */
  specRef: Schema.optional(TrimmedNonEmptyString),
  specRevision: Schema.optional(TrimmedNonEmptyString),
  /** `partial` declares that the included changes do not cover the whole Spec or landing. */
  coverage: Schema.Literals(["complete", "partial"]),
  /** A delta review of material changes since an earlier report of the same scope. */
  priorReview: Schema.optional(
    Schema.Struct({ workId: TrimmedNonEmptyString, sourceRevision: TrimmedNonEmptyString }),
  ),
});
export type AgentReviewRequest = typeof AgentReviewRequest.Type;

export const AgentExecutionRequirement = Schema.Literals([
  "sandbox-required",
  "trusted-host-allowed",
]);
export type AgentExecutionRequirement = typeof AgentExecutionRequirement.Type;
export const AgentExecutionBoundary = Schema.Literals([
  "read-only",
  "workspace-sandbox",
  "trusted-host-access",
]);
export type AgentExecutionBoundary = typeof AgentExecutionBoundary.Type;
/**
 * The boundary a managed task is admitted with. Codex and Claude enforce it natively; any
 * other provider runs under its account's own permissions, whatever boundary is recorded.
 */

/** A coherent work identity survives new launch attempts and transport retries. */
const agentTaskRequestFields = {
  executionRequirement: Schema.optional(AgentExecutionRequirement),
  workUnitId: Schema.optional(TrimmedNonEmptyString),
  role: AgentRole,
  taskClass: AgentTaskClass,
  workId: TrimmedNonEmptyString,
  attemptId: TrimmedNonEmptyString,
  workspacePath: TrimmedNonEmptyString,
  /**
   * The registered project whose repository holds `workspacePath`. Absent means the caller's
   * own project when the path is in its repository, otherwise the one registered project whose
   * repository holds it; needed only when several projects share that repository.
   */
  projectId: Schema.optional(ProjectId),
  /** Absent means `lead`; records from before isolated workspaces are all lead-bound. */
  workspaceAssignment: Schema.optional(AgentWorkspaceAssignment),
  sourceRevision: Schema.optional(TrimmedNonEmptyString),
  /** Required for reviewer roles; absent on records from before typed review scope. */
  review: Schema.optional(AgentReviewRequest),
  demanding: Schema.optional(Schema.Boolean),
  readOnly: Schema.optional(Schema.Boolean),
  authorModel: Schema.optional(TrimmedNonEmptyString),
};
/**
 * Task records written before the reviewer split name `reviewer`. They decode as the
 * reviewer for their scope (a change by default) and are never written again.
 */
const legacyReviewer = <R extends { readonly review?: { readonly scope: string } | undefined }>(
  record: R,
) => ({
  ...record,
  role: record.review?.scope === "spec" ? ("spec-reviewer" as const) : ("ticket-reviewer" as const),
});
const CurrentAgentTaskRequest = Schema.Struct(agentTaskRequestFields);
export const AgentTaskRequest = Schema.Union([
  CurrentAgentTaskRequest,
  Schema.Struct({ ...agentTaskRequestFields, role: Schema.Literal("reviewer") }).pipe(
    Schema.decodeTo(CurrentAgentTaskRequest, {
      decode: SchemaGetter.transform(legacyReviewer),
      encode: SchemaGetter.forbidden(() => "The reviewer role name is retired."),
    }),
  ),
]);
export type AgentTaskRequest = typeof AgentTaskRequest.Type;

const agentTaskBindingFields = {
  ...agentTaskRequestFields,
  executionBoundary: Schema.optional(AgentExecutionBoundary),
  requestFingerprint: Sha256,
  policyHash: Sha256,
  policyRevision: TrimmedNonEmptyString,
  briefHash: Sha256,
  sourceAccess: Schema.Literals(["read-only", "scoped-write"]),
  toolProfile: AgentToolProfile,
  requested: ModelSelection,
  assigned: Schema.NullOr(ModelSelection),
  effective: ModelSelection,
  externalOwner: Schema.optional(
    Schema.Struct({
      environmentId: EnvironmentId,
      clientSessionId: TrimmedNonEmptyString,
      externalSessionKey: Sha256,
      projectId: ProjectId,
      ceiling: RuntimeMode,
    }),
  ),
};
const CurrentAgentTaskBinding = Schema.Struct(agentTaskBindingFields);
export const AgentTaskBinding = Schema.Union([
  CurrentAgentTaskBinding,
  Schema.Struct({ ...agentTaskBindingFields, role: Schema.Literal("reviewer") }).pipe(
    Schema.decodeTo(CurrentAgentTaskBinding, {
      decode: SchemaGetter.transform(legacyReviewer),
      encode: SchemaGetter.forbidden(() => "The reviewer role name is retired."),
    }),
  ),
]);

export type AgentTaskBinding = typeof AgentTaskBinding.Type;

export const AgentSessionAttachInput = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  workspacePath: TrimmedNonEmptyString,
  externalSessionId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type AgentSessionAttachInput = typeof AgentSessionAttachInput.Type;
export const AgentExternalSession = Schema.Struct({
  ...AgentSessionAttachInput.fields,
  key: Sha256,
  clientSessionId: TrimmedNonEmptyString,
  ceiling: RuntimeMode,
});
export type AgentExternalSession = typeof AgentExternalSession.Type;

export const AgentRolesInput = Schema.Struct({
  executionRequirement: Schema.optional(AgentExecutionRequirement),
  runtimeMode: Schema.optional(RuntimeMode),
  externalSessionKey: Schema.optional(Sha256),
  taskClass: AgentTaskClass,
  demanding: Schema.optional(Schema.Boolean),
  readOnly: Schema.optional(Schema.Boolean),
  sourceRevision: Schema.optional(TrimmedNonEmptyString),
  /** Check a model within each role, as a delegation's target would choose it. */
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  /** The model that wrote the work a reviewer would check, as a review delegation states it. */
  authorModel: Schema.optional(TrimmedNonEmptyString),
});
export type AgentRolesInput = typeof AgentRolesInput.Type;
/** How one model and account in a role's list fared when the role was resolved. */
export const AgentPolicyCandidate = Schema.Struct({
  alias: Schema.String,
  model: Schema.String,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  reason: Schema.String,
});
export type AgentPolicyCandidate = typeof AgentPolicyCandidate.Type;
export const AgentRolesResult = Schema.Struct({
  environmentId: EnvironmentId,
  policyHash: Sha256,
  policyRevision: TrimmedNonEmptyString,
  roles: Schema.Array(
    Schema.Struct({
      role: AgentRole,
      sourceAccess: Schema.Literals(["read-only", "scoped-write"]),
      toolProfile: AgentToolProfile,
      briefHash: Sha256,
      executionRequirement: Schema.optional(AgentExecutionRequirement),
      executionBoundary: Schema.optional(AgentExecutionBoundary),
      selection: Schema.NullOr(ModelSelection),
      refusal: Schema.NullOr(TrimmedNonEmptyString),
      /** Accounts out of usage, passed over unless every candidate is; absent when none is. */
      usageLimited: Schema.optional(Schema.Array(AgentPolicyCandidate)),
    }),
  ),
});
export type AgentRolesResult = typeof AgentRolesResult.Type;

/**
 * The source a finished isolated writer hands back for the lead to adopt. `quiescent` is
 * false when the workspace still has uncommitted changes outside the reported revision.
 */
export const AgentTaskHandoff = Schema.Struct({
  workspacePath: TrimmedNonEmptyString,
  revision: Schema.NullOr(TrimmedNonEmptyString),
  quiescent: Schema.Boolean,
});
export type AgentTaskHandoff = typeof AgentTaskHandoff.Type;
