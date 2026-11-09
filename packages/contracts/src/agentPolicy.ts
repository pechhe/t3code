import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { EnvironmentId, IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { BrowserBackend, PhiBrowserLane } from "./browserBackend.ts";
import { ModelSelection } from "./modelSelection.ts";

export const AgentRole = Schema.Literals([
  "chore-worker",
  "implementation-worker",
  "ui-worker",
  "browser",
  "ui-verifier",
  "advisor",
  "reviewer",
  "researcher",
  "scout",
  "lead",
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
  reviewer: "Reviewer",
  researcher: "Researcher",
  scout: "Scout",
  lead: "Spec lead",
} as const satisfies Record<AgentRole, string>;
/**
 * A managed task's title without its role prefix, for places that already show the role as
 * a chip. Empty when the title names only the role; unchanged when it lacks the prefix.
 */
export const agentTaskTopic = (title: string, role: AgentRole): string => {
  const labels =
    role === "reviewer"
      ? [AGENT_ROLE_TITLE_LABEL[role], "Ticket reviewer", "Spec reviewer"]
      : [AGENT_ROLE_TITLE_LABEL[role]];
  for (const label of labels) {
    if (title === label) return "";
    if (title.startsWith(`${label} · `)) return title.slice(label.length + 3);
  }
  return title;
};
/**
 * A `lead` task runs one Spec under a top-level thread's runtime policy; every other role is a leaf
 * under its task's policy. This is lifecycle only: what a task may call comes from
 * `isReadOnlyTask`, and every editor may call the same things.
 */
export const isLeafAgentTask = (task: { readonly role: AgentRole } | undefined) =>
  task !== undefined && task.role !== "lead";
/** Which of the two permission classes a task is in; a thread with no task is an editor. */
export const isReadOnlyTask = (
  task: { readonly sourceAccess: "read-only" | "scoped-write" } | undefined,
) => task?.sourceAccess === "read-only";
/**
 * Roles that are read-only whatever the policy says, so a read-only agent may delegate them
 * without resolving a role. `validManifest` holds the policy to this; a writing role the policy
 * narrows to read-only is read-only too, which is how a policy revokes its writes.
 */
export const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set([
  "browser",
  "ui-verifier",
  "advisor",
  "reviewer",
  "researcher",
  "scout",
]);
/** A subagent thread other than a `lead` task: it reports its result to its parent. */
export const isLeafSubagentThread = (thread: {
  readonly lineage: { readonly relationshipToParent: string | null };
  readonly agentTask?: { readonly role: AgentRole } | undefined;
}) => thread.lineage.relationshipToParent === "subagent" && thread.agentTask?.role !== "lead";
/** The roles that judge pinned work: fresh-context, read-only and scoped by `review`. */
export const isReviewerRole = (role: AgentRole) => role === "reviewer";
/**
 * The managed roles a policy may grant bounded browser tasks: the writers and the independent
 * reviewer. Consulting roles never get them, and the browser roles keep their own endpoint.
 */
export const BOUNDED_BROWSER_ROLES: ReadonlySet<AgentRole> = new Set([
  "chore-worker",
  "implementation-worker",
  "ui-worker",
  "reviewer",
]);
/** Whether a role's policy grants its tasks bounded browser tasks; recorded on the binding. */
export const grantsBrowserTasks = (
  role: AgentRole,
  policy: { readonly browserTasks?: boolean | undefined },
): boolean => policy.browserTasks === true && BOUNDED_BROWSER_ROLES.has(role);
/** The read-only roles that answer the lead's questions rather than produce work. */
export const isConsultingRole = (role: AgentRole) =>
  role === "advisor" || role === "researcher" || role === "scout";
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
  reviewer: "review",
  researcher: "research",
  scout: "research",
  lead: "implementation",
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
 * `phi` reads source and drives a managed browser, integrated or Phi: the browser role's.
 */
export const AgentToolProfile = Schema.Literals([
  "source-reader",
  "implementation",
  "phi",
  "web-research",
]);
export type AgentToolProfile = typeof AgentToolProfile.Type;
/**
 * The retired UI-writer profile that also drove Phi. Saved policies, snapshots and task
 * bindings still carry it; it reads back as `implementation` with bounded browser tasks.
 */
const RetiredWriterProfile = Schema.Literal("implementation-phi");
/** Whether a task with this profile gets its own managed browser endpoint. */
export const usesPhi = (profile: AgentToolProfile | undefined) => profile === "phi";
/** The profile a role runs with when a task narrows it to read-only: it loses writing, not Phi. */
export const readOnlyToolProfile = (profile: AgentToolProfile): AgentToolProfile =>
  profile === "implementation" ? "source-reader" : profile;
const ModelBinding = Schema.Struct({
  driverKind: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  /** The select option carrying effort; absent for a model that has no effort setting. */
  effortOption: Schema.optional(TrimmedNonEmptyString),
  /** Select options every task on this model carries beside effort, e.g. `serviceTier: "fast"`. */
  options: Schema.optional(Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString)),
});

const MAKER_FAMILIES: ReadonlyArray<readonly [string, string]> = [
  ["claude", "anthropic"],
  ["gpt", "openai"],
  ["codex", "openai"],
  ["gemini", "google"],
  ["gemma", "google"],
  ["deepseek", "deepseek"],
  ["kimi", "moonshot"],
  ["grok", "xai"],
  ["qwen", "alibaba"],
  ["llama", "meta"],
  ["mistral", "mistral"],
  ["glm", "zhipu"],
];
/** Gateway slugs such as `openrouter/openai/o3` name the vendor in the segment before the model. */
const VENDOR_MAKERS: Readonly<Record<string, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  "x-ai": "xai",
  xai: "xai",
  moonshotai: "moonshot",
  deepseek: "deepseek",
  "meta-llama": "meta",
  mistralai: "mistral",
  qwen: "alibaba",
  "z-ai": "zhipu",
};
const DRIVER_MAKERS: Readonly<Record<string, string>> = {
  codex: "openai",
  claudeAgent: "anthropic",
  grok: "xai",
};

/**
 * Who made a model, whichever connection serves it: gateways such as OpenCode, Pi or
 * OpenRouter name it by slug, so the slug's family decides before the driver does.
 */
export function modelMaker(binding: { readonly driverKind: string; readonly model: string }) {
  const segments = binding.model.toLowerCase().split("/");
  const name = segments.at(-1)!;
  return (
    MAKER_FAMILIES.find(([family]) => name.startsWith(family))?.[1] ??
    VENDOR_MAKERS[segments.at(-2) ?? ""] ??
    DRIVER_MAKERS[binding.driverKind] ??
    name.split(/[-.:]/)[0]!
  );
}

/** A model a role may use and, when the model has one, the effort it runs at. */
export const AgentListEntry = Schema.Struct({
  model: Alias,
  effort: Schema.optional(TrimmedNonEmptyString),
});
export type AgentListEntry = typeof AgentListEntry.Type;
const RolePolicy = Schema.Struct({
  /** The ordered model list this role uses; roles naming the same list share it. */
  list: Alias,
  /** Reviewer only: the ordered list for Spec-scope reviews. */
  specList: Schema.optional(Alias),
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
  /**
   * Reviewer only: a Spec review sits one member per model maker from `specList`, in list
   * order, instead of one reviewer. Absent or false keeps one reviewer.
   */
  council: Schema.optional(Schema.Boolean),
  /**
   * The role's tasks may run bounded browser tasks when their project allows agent browsing.
   * Orthogonal to source access and tool profile; absent keeps the role without them.
   */
  browserTasks: Schema.optional(Schema.Boolean),
});
const StoredRolePolicy = Schema.Union([
  RolePolicy,
  Schema.Struct({ ...RolePolicy.fields, toolProfile: RetiredWriterProfile }).pipe(
    Schema.decodeTo(RolePolicy, {
      decode: SchemaGetter.transform((role) => ({
        ...role,
        toolProfile: "implementation" as const,
        browserTasks: true,
      })),
      encode: SchemaGetter.forbidden(() => "implementation-phi is never written."),
    }),
  ),
]);

/**
 * One entry per role. `researcher`, `scout` and `lead` were added after policies and task
 * snapshots were saved, so a policy may leave them out; such a role is then unavailable.
 * `ui-verifier` is retired: saved snapshots still carry it, and a policy may no longer set it.
 */
const rolesRecord = <S extends Schema.Top>(entry: S) =>
  Schema.Struct({
    "chore-worker": entry,
    "implementation-worker": entry,
    "ui-worker": entry,
    browser: entry,
    "ui-verifier": Schema.optionalKey(entry),
    advisor: entry,
    reviewer: entry,
    researcher: Schema.optionalKey(entry),
    scout: Schema.optionalKey(entry),
    lead: Schema.optionalKey(entry),
  });

const manifestFields = {
  version: Schema.Literal(2),
  revision: TrimmedNonEmptyString,
  models: Schema.Record(Alias, ModelBinding),
  /** Each list orders the models a role may use; the first available one is the default. */
  lists: Schema.Record(Alias, Schema.Array(AgentListEntry).check(Schema.isMinLength(1))),
};
const Manifest = Schema.Struct({ ...manifestFields, roles: rolesRecord(StoredRolePolicy) });

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
    if ((name === "reviewer") !== (role.specList !== undefined)) return false;
    if (role.specList !== undefined && lists[role.specList] === undefined) return false;
    const list = lists[role.list]?.map((entry) => entry.model);
    if (list === undefined || role.brief !== `roles/${name}.md`) return false;
    if (role.large !== undefined && !list.includes(role.large.model)) return false;
    if (role.large !== undefined && !hasEffort(role.large)) return false;
    for (const [caller, first] of Object.entries(role.callers ?? {}))
      if (models[caller] === undefined || !list.includes(first)) return false;
    if (role.preferOtherAuthorProvider !== undefined && !isReviewerRole(name as AgentRole))
      return false;
    if (role.browserTasks === true && !BOUNDED_BROWSER_ROLES.has(name as AgentRole)) return false;
    if (role.council !== undefined && name !== "reviewer") return false;
  }
  const readOnly = (role: (typeof roles)[AgentRole], toolProfile: string) =>
    role?.sourceAccess === "read-only" && role.toolProfile === toolProfile;
  return (
    (roles.researcher === undefined || readOnly(roles.researcher, "web-research")) &&
    (roles.scout === undefined || readOnly(roles.scout, "source-reader")) &&
    (roles.lead === undefined ||
      (roles.lead.sourceAccess === "scoped-write" &&
        roles.lead.toolProfile === "implementation")) &&
    readOnly(roles.browser, "phi") &&
    (roles["ui-verifier"] === undefined || readOnly(roles["ui-verifier"], "phi")) &&
    [roles.reviewer, roles.advisor].every((role) => readOnly(role, "source-reader")) &&
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
 * What a policy save may set: the current form only, without the retired `ui-verifier` role
 * or `implementation-phi` profile. A saved role it leaves out is dropped from the file.
 */
const { "ui-verifier": _retired, ...editableRoles } = rolesRecord(RolePolicy).fields;
export const AgentPolicyManifestEdit = Schema.Struct({
  ...manifestFields,
  roles: Schema.Struct(editableRoles),
}).check(Schema.makeFilter(validManifest));

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
      toolProfile: Schema.Union([AgentToolProfile, RetiredWriterProfile]),
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
  const roles: Record<string, typeof StoredRolePolicy.Encoded> = {};
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
    const name = legacyName as AgentRole;
    lists[name] = order.map((model) => ({ model, effort: role.effort[model]!.default }));
    roles[name] = {
      list: name,
      ...(name === "reviewer" ? { specList: name } : {}),
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
  return {
    version: 2,
    revision: legacy.revision,
    models: legacy.models,
    lists,
    roles: roles as (typeof Manifest.Encoded)["roles"],
  };
};
const SplitManifest = Schema.Struct({
  ...Manifest.fields,
  roles: Schema.Struct({
    ...rolesRecord(StoredRolePolicy).fields,
    reviewer: Schema.optionalKey(StoredRolePolicy),
    "ticket-reviewer": StoredRolePolicy,
    "spec-reviewer": StoredRolePolicy,
  }),
});
const mergeReviewers = (split: typeof SplitManifest.Type): typeof Manifest.Encoded => {
  const {
    "ticket-reviewer": change,
    "spec-reviewer": spec,
    reviewer: _reviewer,
    ...roles
  } = split.roles;
  return {
    ...split,
    roles: {
      ...roles,
      reviewer: {
        ...change,
        specList: spec.list,
        brief: "roles/reviewer.md",
        preferOtherAuthorProvider:
          change.preferOtherAuthorProvider === true || spec.preferOtherAuthorProvider === true,
      },
    },
  };
};
export const AgentPolicyManifest = Schema.Union([
  CurrentManifest,
  SplitManifest.check(
    Schema.makeFilter((split) => {
      const {
        "ticket-reviewer": change,
        "spec-reviewer": spec,
        reviewer: _reviewer,
        ...roles
      } = split.roles;
      return (
        [
          ["ticket-reviewer", change],
          ["spec-reviewer", spec],
        ] as const
      ).every(([name, role]) => {
        return (
          role.brief === `roles/${name}.md` &&
          validManifest({
            ...split,
            roles: {
              ...roles,
              reviewer: { ...role, specList: role.list, brief: "roles/reviewer.md" },
            },
          })
        );
      });
    }),
  ).pipe(
    Schema.decodeTo(CurrentManifest, {
      decode: SchemaGetter.transform(mergeReviewers),
      encode: SchemaGetter.forbidden(() => "Split reviewer policies are never written."),
    }),
  ),
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
  Schema.Struct({
    ...Snapshot.fields,
    briefs: Schema.Struct({
      ...rolesRecord(Brief).fields,
      reviewer: Schema.optionalKey(Brief),
      "ticket-reviewer": Brief,
      "spec-reviewer": Brief,
    }),
  }).pipe(
    Schema.decodeTo(Snapshot, {
      decode: SchemaGetter.transform(
        ({
          briefs: { "ticket-reviewer": _change, "spec-reviewer": reviewer, ...briefs },
          ...snapshot
        }) => ({
          ...snapshot,
          briefs: { ...briefs, reviewer },
        }),
      ),
      encode: SchemaGetter.forbidden(() => "Split reviewer snapshots are never written."),
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
 * What a reviewer judges: a candidate change or a Spec's integrated outcome.
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
  /** Set by T3 when it sits a council: the maker this reviewer sits for, or `solo`. */
  councilSeat: Schema.optional(TrimmedNonEmptyString),
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
/** A reader only reads; every writer runs on the host unless its request requires a sandbox. */
export function managedExecution(input: {
  readonly readOnly: boolean;
  readonly requested?: AgentExecutionRequirement | undefined;
}): {
  readonly executionRequirement: AgentExecutionRequirement;
  readonly executionBoundary: AgentExecutionBoundary;
} {
  if (input.readOnly)
    return { executionRequirement: "sandbox-required", executionBoundary: "read-only" };
  return input.requested === "sandbox-required"
    ? { executionRequirement: "sandbox-required", executionBoundary: "workspace-sandbox" }
    : { executionRequirement: "trusted-host-allowed", executionBoundary: "trusted-host-access" };
}

/** A coherent work identity survives new launch attempts and transport retries. */
export const AgentTaskBrowser = Schema.Struct({
  backend: BrowserBackend,
  phiLane: Schema.optional(PhiBrowserLane),
});
export type AgentTaskBrowser = typeof AgentTaskBrowser.Type;

const agentTaskRequestFields = {
  browser: Schema.optional(AgentTaskBrowser),
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
// Persisted split-role tasks retain their review scope while adopting the merged role.
const legacyReviewer = <R extends object>(record: R) => ({ ...record, role: "reviewer" as const });
const SplitReviewerRole = Schema.Literals(["ticket-reviewer", "spec-reviewer"]);
/** A role saved outside a task record, such as on a schedule; split names read as `reviewer`. */
export const StoredAgentRole = Schema.Union([AgentRole, SplitReviewerRole]).pipe(
  Schema.decodeTo(AgentRole, {
    decode: SchemaGetter.transform((role) =>
      role === "ticket-reviewer" || role === "spec-reviewer" ? "reviewer" : role,
    ),
    encode: SchemaGetter.transform((role) => role),
  }),
);
const CurrentAgentTaskRequest = Schema.Struct(agentTaskRequestFields);
export const AgentTaskRequest = Schema.Union([
  CurrentAgentTaskRequest,
  Schema.Struct({ ...agentTaskRequestFields, role: SplitReviewerRole }).pipe(
    Schema.decodeTo(CurrentAgentTaskRequest, {
      decode: SchemaGetter.transform(legacyReviewer),
      encode: SchemaGetter.forbidden(() => "Split reviewer role names are never written."),
    }),
  ),
]);
export type AgentTaskRequest = typeof AgentTaskRequest.Type;

export const AgentTaskWireRequest = Schema.Struct({
  ...agentTaskRequestFields,
  role: Schema.Union([AgentRole, SplitReviewerRole]),
});
export type AgentTaskWireRequest = typeof AgentTaskWireRequest.Type;

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
  /**
   * Recorded from the role policy when the task was bound, never from the request, so a
   * caller cannot grant it. Absent on tasks bound before the capability existed.
   */
  browserTasks: Schema.optional(Schema.Literal(true)),
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
/**
 * A UI worker bound while its profile drove Phi resumes with the same source access, bounded
 * browser tasks and no Phi: `implementation-phi` reads back as `implementation`, a read-only
 * one's `phi` as `source-reader`, and its Phi selection is dropped.
 */
const StoredAgentTaskBinding = Schema.toEncoded(
  Schema.Struct({
    ...agentTaskBindingFields,
    toolProfile: Schema.Union([AgentToolProfile, RetiredWriterProfile]),
  }),
).pipe(
  Schema.decodeTo(CurrentAgentTaskBinding, {
    decode: SchemaGetter.transform(({ toolProfile, ...binding }) => {
      if (binding.role === "ui-worker") {
        const { browser: _phi, ...uiWorker } = binding;
        if (toolProfile === "implementation-phi")
          return {
            ...uiWorker,
            toolProfile: "implementation" as const,
            browserTasks: true as const,
          };
        if (toolProfile === "phi")
          return {
            ...uiWorker,
            toolProfile: "source-reader" as const,
            browserTasks: true as const,
          };
        return { ...uiWorker, toolProfile };
      }
      if (toolProfile === "implementation-phi")
        return { ...binding, toolProfile: "implementation" as const, browserTasks: true as const };
      return { ...binding, toolProfile };
    }),
    encode: SchemaGetter.transform((binding) => binding),
  }),
);
export const AgentTaskBinding = Schema.Union([
  StoredAgentTaskBinding,
  Schema.Struct({ ...agentTaskBindingFields, role: SplitReviewerRole }).pipe(
    Schema.decodeTo(CurrentAgentTaskBinding, {
      decode: SchemaGetter.transform(legacyReviewer),
      encode: SchemaGetter.forbidden(() => "Split reviewer role names are never written."),
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
  browser: Schema.optional(AgentTaskBrowser),
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
  /** Reviewer discovery defaults to the change list when omitted. */
  reviewScope: Schema.optional(AgentReviewScope),
});
export type AgentRolesInput = typeof AgentRolesInput.Type;
/** How one model and account in a role's list fared when the role was resolved. */
export const AgentPolicyCandidate = Schema.Struct({
  alias: Schema.String,
  model: Schema.String,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  reason: Schema.String,
  /** When an `overloaded` candidate's cool-down ends and it may serve again. */
  until: Schema.optional(IsoDateTime),
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
      /** Which of T3's two permission classes the role's tasks are in. */
      permissionClass: Schema.optional(Schema.Literals(["editor", "read-only"])),
      /** Present only for the narrow sets that read untrusted pages (browser and researcher). */
      toolProfile: Schema.optional(AgentToolProfile),
      briefHash: Sha256,
      executionRequirement: Schema.optional(AgentExecutionRequirement),
      executionBoundary: Schema.optional(AgentExecutionBoundary),
      /** The role's tasks get bounded browser tasks while their project allows agent browsing. */
      browserTasks: Schema.optional(Schema.Boolean),
      selection: Schema.NullOr(ModelSelection),
      refusal: Schema.NullOr(TrimmedNonEmptyString),
      /** Accounts out of usage, passed over unless every candidate is; absent when none is. */
      usageLimited: Schema.optional(Schema.Array(AgentPolicyCandidate)),
      /** Models in an overload cool-down, passed over while a healthy candidate remains. */
      overloaded: Schema.optional(Schema.Array(AgentPolicyCandidate)),
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
