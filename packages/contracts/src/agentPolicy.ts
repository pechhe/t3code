import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { ModelSelection } from "./modelSelection.ts";

export const AgentRole = Schema.Literals([
  "chore-worker",
  "implementation-worker",
  "ui-worker",
  "browser",
  "ui-verifier",
  "advisor",
  "reviewer",
]);
export type AgentRole = typeof AgentRole.Type;
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
} as const satisfies Record<AgentRole, string>;

export const AgentTaskClass = Schema.Literals(["non-ui", "ui", "mixed"]);
export type AgentTaskClass = typeof AgentTaskClass.Type;
export const AgentModelPool = Schema.Literals(["fast", "workhorse", "ui", "advisor"]);
export type AgentModelPool = typeof AgentModelPool.Type;

const Alias = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));
const Aliases = Schema.Array(Alias).check(
  Schema.makeFilter((values) => new Set(values).size === values.length),
);
const BriefPath = TrimmedNonEmptyString.check(Schema.isPattern(/^roles\/[a-z][a-z0-9-]*\.md$/));
const Effort = Schema.Struct({
  default: TrimmedNonEmptyString,
  demanding: Schema.optional(TrimmedNonEmptyString),
});
const RolePolicy = Schema.Struct({
  pool: AgentModelPool,
  brief: BriefPath,
  sourceAccess: Schema.Literals(["read-only", "scoped-write"]),
  toolProfile: Schema.Literals(["source-reader", "implementation", "phi"]),
  taskClasses: Schema.Array(AgentTaskClass).check(Schema.isMinLength(1)),
  /** A restriction only narrows the pool; an absent class uses the pool's allowlist. */
  restrictions: Schema.Struct({
    "non-ui": Schema.optional(Aliases),
    ui: Schema.optional(Aliases),
    mixed: Schema.optional(Aliases),
  }),
  effort: Schema.Record(Alias, Effort),
});

const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  revision: TrimmedNonEmptyString,
  models: Schema.Record(
    Alias,
    Schema.Struct({
      driverKind: ProviderDriverKind,
      model: TrimmedNonEmptyString,
      effortOption: TrimmedNonEmptyString,
    }),
  ),
  pools: Schema.Record(
    AgentModelPool,
    Schema.Struct({
      allow: Aliases.check(Schema.isMinLength(1)),
      prefer: Aliases,
    }),
  ),
  roles: Schema.Record(AgentRole, RolePolicy),
});

/** Structural authority is fixed; model identities/preferences belong to the versioned policy. */
function validManifest(manifest: typeof Manifest.Type): boolean {
  const { pools, models, roles } = manifest;
  for (const pool of Object.values(pools)) {
    if (pool.allow.some((alias) => models[alias] === undefined)) return false;
    if (pool.prefer.some((alias) => !pool.allow.includes(alias))) return false;
  }
  for (const [name, role] of Object.entries(roles)) {
    const pool = pools[role.pool];
    if (role.brief !== `roles/${name}.md`) return false;
    for (const taskClass of role.taskClasses) {
      const eligible = role.restrictions[taskClass] ?? pool.allow;
      if (
        eligible.length === 0 ||
        eligible.some((alias) => !pool.allow.includes(alias) || !role.effort[alias])
      )
        return false;
    }
    for (const [taskClass, restriction] of Object.entries(role.restrictions)) {
      if (
        restriction !== undefined &&
        (!role.taskClasses.includes(taskClass as AgentTaskClass) ||
          restriction.some((alias) => !pool.allow.includes(alias)))
      )
        return false;
    }
    if (Object.keys(role.effort).some((alias) => !pool.allow.includes(alias))) return false;
  }
  return (
    roles["chore-worker"].pool === "fast" &&
    roles["implementation-worker"].pool === "workhorse" &&
    roles.reviewer.pool === "workhorse" &&
    roles["ui-worker"].pool === "ui" &&
    roles.advisor.pool === "advisor" &&
    [roles.browser, roles["ui-verifier"]].every(
      (role) =>
        role.pool === "fast" && role.toolProfile === "phi" && role.sourceAccess === "read-only",
    ) &&
    [roles.reviewer, roles.advisor].every(
      (role) => role.sourceAccess === "read-only" && role.toolProfile === "source-reader",
    ) &&
    [roles["chore-worker"], roles["implementation-worker"]].every(
      (role) =>
        role.taskClasses.length === 1 &&
        role.taskClasses[0] === "non-ui" &&
        role.toolProfile === "implementation",
    )
  );
}

export const AgentPolicyManifest = Manifest.check(Schema.makeFilter(validManifest));
export type AgentPolicyManifest = typeof AgentPolicyManifest.Type;
export const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const AgentPolicySnapshot = Schema.Struct({
  hash: Sha256,
  sourceRevision: TrimmedNonEmptyString,
  manifest: AgentPolicyManifest,
  briefs: Schema.Record(
    AgentRole,
    Schema.Struct({
      hash: Sha256,
      // Keep the exact bytes represented by the brief hash, including trailing newlines.
      text: Schema.String.check(Schema.makeFilter((text) => text.trim().length > 0)),
    }),
  ),
});
export type AgentPolicySnapshot = typeof AgentPolicySnapshot.Type;

/** A coherent work identity survives new launch attempts and transport retries. */
export const AgentTaskRequest = Schema.Struct({
  workUnitId: Schema.optional(TrimmedNonEmptyString),
  role: AgentRole,
  taskClass: AgentTaskClass,
  workId: TrimmedNonEmptyString,
  attemptId: TrimmedNonEmptyString,
  workspacePath: TrimmedNonEmptyString,
  sourceRevision: Schema.optional(TrimmedNonEmptyString),
  demanding: Schema.optional(Schema.Boolean),
  readOnly: Schema.optional(Schema.Boolean),
  authorModel: Schema.optional(TrimmedNonEmptyString),
});
export type AgentTaskRequest = typeof AgentTaskRequest.Type;

export const AgentTaskBinding = Schema.Struct({
  ...AgentTaskRequest.fields,
  requestFingerprint: Sha256,
  policyHash: Sha256,
  policyRevision: TrimmedNonEmptyString,
  briefHash: Sha256,
  sourceAccess: Schema.Literals(["read-only", "scoped-write"]),
  toolProfile: Schema.Literals(["source-reader", "implementation", "phi"]),
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
});
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
  externalSessionKey: Schema.optional(Sha256),
  taskClass: AgentTaskClass,
  demanding: Schema.optional(Schema.Boolean),
  readOnly: Schema.optional(Schema.Boolean),
  sourceRevision: Schema.optional(TrimmedNonEmptyString),
});
export type AgentRolesInput = typeof AgentRolesInput.Type;
export const AgentRolesResult = Schema.Struct({
  environmentId: EnvironmentId,
  policyHash: Sha256,
  policyRevision: TrimmedNonEmptyString,
  roles: Schema.Array(
    Schema.Struct({
      role: AgentRole,
      sourceAccess: Schema.Literals(["read-only", "scoped-write"]),
      toolProfile: Schema.Literals(["source-reader", "implementation", "phi"]),
      briefHash: Sha256,
      selection: Schema.NullOr(ModelSelection),
      refusal: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
});
export type AgentRolesResult = typeof AgentRolesResult.Type;
