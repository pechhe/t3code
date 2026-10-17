import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  AgentPolicyManifest,
  AgentPolicySnapshot,
  AgentTaskRequest,
  agentTaskTopic,
} from "./agentPolicy.ts";

const decodeManifest = Schema.decodeUnknownSync(AgentPolicyManifest);
const encodeManifest = Schema.encodeSync(AgentPolicyManifest);
const decodeManifestExit = Schema.decodeUnknownExit(AgentPolicyManifest);
const decodeSnapshot = Schema.decodeUnknownSync(AgentPolicySnapshot);
const decodeRequest = Schema.decodeUnknownSync(AgentTaskRequest);

const role = (pool: string, effort: Record<string, object>, extra: object = {}) => ({
  pool,
  sourceAccess: "read-only",
  toolProfile: "source-reader",
  taskClasses: ["non-ui"],
  restrictions: {},
  effort,
  ...extra,
});
const legacy = {
  version: 1,
  revision: "2026-10-15.2",
  models: {
    haiku: { driverKind: "claudeAgent", model: "claude-haiku", effortOption: "effort" },
    luna: { driverKind: "codex", model: "gpt-luna", effortOption: "reasoningEffort" },
    sol: { driverKind: "codex", model: "gpt-sol", effortOption: "reasoningEffort" },
    sonnet: { driverKind: "claudeAgent", model: "claude-sonnet", effortOption: "effort" },
    opus: { driverKind: "claudeAgent", model: "claude-opus", effortOption: "effort" },
  },
  pools: {
    fast: { allow: ["haiku", "luna"], prefer: ["haiku", "luna"] },
    workhorse: { allow: ["sol", "sonnet"], prefer: ["sol", "sonnet"] },
    ui: { allow: ["opus"], prefer: ["opus"] },
    advisor: { allow: ["opus", "sonnet"], prefer: ["opus"] },
  },
  roles: {
    "chore-worker": {
      ...role("fast", { haiku: { default: "high" }, luna: { default: "high" } }),
      brief: "roles/chore-worker.md",
      sourceAccess: "scoped-write",
      toolProfile: "implementation",
    },
    "implementation-worker": {
      ...role("workhorse", {
        sol: { default: "medium", demanding: "high" },
        sonnet: { default: "medium", demanding: "high" },
      }),
      brief: "roles/implementation-worker.md",
      sourceAccess: "scoped-write",
      toolProfile: "implementation",
    },
    "ui-worker": {
      ...role("ui", { opus: { default: "high" } }),
      brief: "roles/ui-worker.md",
      sourceAccess: "scoped-write",
      toolProfile: "implementation",
      taskClasses: ["ui", "mixed"],
    },
    browser: {
      ...role("fast", { haiku: { default: "medium" } }, { restrictions: { "non-ui": ["haiku"] } }),
      brief: "roles/browser.md",
      toolProfile: "phi",
    },
    "ui-verifier": {
      ...role("fast", { haiku: { default: "low" } }),
      brief: "roles/ui-verifier.md",
      toolProfile: "phi",
    },
    advisor: {
      ...role("advisor", { opus: { default: "high" }, sonnet: { default: "high" } }),
      brief: "roles/advisor.md",
    },
    reviewer: {
      ...role("workhorse", { sol: { default: "medium" }, sonnet: { default: "medium" } }),
      brief: "roles/reviewer.md",
    },
  },
  reviewer: { prefer: ["sonnet", "sol"], requireDifferentProvider: true },
};

describe("AgentPolicyManifest", () => {
  it("reads a version 1 policy as one ordered list per role", () => {
    const manifest = decodeManifest(legacy);
    expect(manifest.version).toBe(2);
    // Preference first, then the rest of the pool; effort is the role's default.
    expect(manifest.lists["advisor"]).toEqual([
      { model: "opus", effort: "high" },
      { model: "sonnet", effort: "high" },
    ]);
    // A restriction on every class narrows the role to its allowed models.
    expect(manifest.lists["browser"]).toEqual([{ model: "haiku", effort: "medium" }]);
    // The first model with a demanding effort becomes the large-task model.
    expect(manifest.roles["implementation-worker"].large).toEqual({ model: "sol", effort: "high" });
    // Both reviewer roles keep the old reviewer's order; a requirement becomes a preference.
    expect(manifest.lists["ticket-reviewer"]?.map((entry) => entry.model)).toEqual([
      "sonnet",
      "sol",
    ]);
    expect(manifest.roles["spec-reviewer"]).toMatchObject({
      brief: "roles/spec-reviewer.md",
      preferOtherAuthorProvider: true,
    });
    // It is written back only in the current version.
    expect(encodeManifest(manifest).version).toBe(2);
  });

  it("refuses a role whose large-task or caller model is outside its list", () => {
    const manifest = encodeManifest(decodeManifest(legacy));
    const edit = (roleEdit: object) =>
      decodeManifestExit({
        ...manifest,
        roles: { ...manifest.roles, advisor: { ...manifest.roles.advisor, ...roleEdit } },
      });
    expect(edit({ large: { model: "sonnet", effort: "high" } })._tag).toBe("Success");
    expect(edit({ large: { model: "haiku", effort: "high" } })._tag).toBe("Failure");
    expect(edit({ callers: { sonnet: "opus" } })._tag).toBe("Success");
    expect(edit({ callers: { sonnet: "haiku" } })._tag).toBe("Failure");
    expect(edit({ preferOtherAuthorProvider: true })._tag).toBe("Failure");
  });

  it("reads a policy without the optional scout and keeps a scout a source reader", () => {
    const manifest = encodeManifest(decodeManifest(legacy));
    expect(decodeManifest(manifest).roles.scout).toBeUndefined();
    const scout = (edit: object) =>
      decodeManifestExit({
        ...manifest,
        roles: {
          ...manifest.roles,
          scout: {
            list: "advisor",
            brief: "roles/scout.md",
            sourceAccess: "read-only",
            toolProfile: "source-reader",
            taskClasses: ["non-ui", "ui", "mixed"],
            ...edit,
          },
        },
      });
    expect(scout({})._tag).toBe("Success");
    expect(scout({ sourceAccess: "scoped-write" })._tag).toBe("Failure");
    expect(scout({ toolProfile: "web-research" })._tag).toBe("Failure");
  });

  it("reads a policy without the optional researcher and keeps a researcher read-only", () => {
    const manifest = encodeManifest(decodeManifest(legacy));
    expect(decodeManifest(manifest).roles.researcher).toBeUndefined();
    const researcher = (edit: object) =>
      decodeManifestExit({
        ...manifest,
        lists: { ...decodeManifest(legacy).lists, researcher: [{ model: "haiku", effort: "high" }] },
        roles: {
          ...manifest.roles,
          researcher: {
            list: "researcher",
            brief: "roles/researcher.md",
            sourceAccess: "read-only",
            toolProfile: "web-research",
            taskClasses: ["non-ui", "ui", "mixed"],
            ...edit,
          },
        },
      });
    expect(researcher({})._tag).toBe("Success");
    expect(researcher({ toolProfile: "source-reader" })._tag).toBe("Failure");
    expect(researcher({ sourceAccess: "scoped-write" })._tag).toBe("Failure");
    // Web access never comes with source writes, whichever role asks for it.
    expect(
      decodeManifestExit({
        ...manifest,
        roles: {
          ...manifest.roles,
          "ui-worker": { ...manifest.roles["ui-worker"], toolProfile: "web-research" },
        },
      })._tag,
    ).toBe("Failure");
  });

  it("lets only the UI worker write source and drive Phi", () => {
    const manifest = encodeManifest(decodeManifest(legacy));
    const withRole = (name: "ui-worker" | "implementation-worker" | "advisor", edit: object) =>
      decodeManifestExit({
        ...manifest,
        roles: { ...manifest.roles, [name]: { ...manifest.roles[name], ...edit } },
      })._tag;
    expect(withRole("ui-worker", { toolProfile: "implementation-phi" })).toBe("Success");
    expect(
      withRole("ui-worker", { toolProfile: "implementation-phi", sourceAccess: "read-only" }),
    ).toBe("Failure");
    expect(withRole("implementation-worker", { toolProfile: "implementation-phi" })).toBe(
      "Failure",
    );
    expect(withRole("advisor", { toolProfile: "implementation-phi" })).toBe("Failure");
  });

  it("reads a stored version 1 snapshot with its reviewer brief for both reviewers", () => {
    const brief = { hash: "b".repeat(64), text: "Brief\n" };
    const snapshot = decodeSnapshot({
      hash: "a".repeat(64),
      sourceRevision: "2026-10-15.2",
      manifest: legacy,
      briefs: Object.fromEntries(Object.keys(legacy.roles).map((name) => [name, brief])),
    });
    expect(snapshot.briefs["ticket-reviewer"]).toEqual(brief);
    expect(snapshot.briefs["spec-reviewer"]).toEqual(brief);
  });
});

describe("AgentTaskRequest", () => {
  const recorded = {
    role: "reviewer",
    taskClass: "non-ui",
    workId: "work",
    attemptId: "attempt",
    workspacePath: "/workspace",
  };
  const review = (scope: string) => ({
    scope,
    baseRevision: "base",
    includedChanges: ["change"],
    coverage: "complete",
  });

  it("reads a recorded reviewer task as the reviewer for its scope", () => {
    expect(decodeRequest(recorded).role).toBe("ticket-reviewer");
    expect(decodeRequest({ ...recorded, review: review("change") }).role).toBe("ticket-reviewer");
    expect(decodeRequest({ ...recorded, review: review("spec") }).role).toBe("spec-reviewer");
  });
});

describe("agentTaskTopic", () => {
  it("drops the role prefix T3 gives a managed task's title", () => {
    expect(agentTaskTopic("Implementation worker · Smoke edit", "implementation-worker")).toBe(
      "Smoke edit",
    );
    expect(agentTaskTopic("Advisor", "advisor")).toBe("");
  });

  it("keeps a title that does not start with the role's label", () => {
    expect(agentTaskTopic("Advisor · Smoke edit", "implementation-worker")).toBe(
      "Advisor · Smoke edit",
    );
  });
});
