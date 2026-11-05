import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  AgentPolicyManifest,
  AgentPolicySnapshot,
  AgentTaskRequest,
  AgentTaskBinding,
  agentTaskTopic,
} from "./agentPolicy.ts";

const decodeManifest = Schema.decodeUnknownSync(AgentPolicyManifest);
const encodeManifest = Schema.encodeSync(AgentPolicyManifest);
const decodeManifestExit = Schema.decodeUnknownExit(AgentPolicyManifest);
const decodeSnapshot = Schema.decodeUnknownSync(AgentPolicySnapshot);
const decodeBinding = Schema.decodeUnknownSync(AgentTaskBinding);
const encodeBinding = Schema.encodeSync(AgentTaskBinding);
const encodeRequest = Schema.encodeSync(AgentTaskRequest);
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
    // The reviewer keeps its order; a requirement becomes a preference.
    expect(manifest.lists["reviewer"]?.map((entry) => entry.model)).toEqual(["sonnet", "sol"]);
    expect(manifest.roles["reviewer"]).toMatchObject({
      brief: "roles/reviewer.md",
      specList: "reviewer",
      preferOtherAuthorProvider: true,
    });
    // It is written back only in the current version.
    expect(encodeManifest(manifest).version).toBe(2);
  });

  it("preserves exact split reviewer lists and decodes stored snapshots", () => {
    const current = decodeManifest(legacy);
    const { reviewer, ...roles } = current.roles;
    const split = {
      ...current,
      lists: {
        ...current.lists,
        changes: [
          { model: "sol", effort: "medium" },
          { model: "sonnet", effort: "low" },
        ],
        specs: [
          { model: "opus", effort: "high" },
          { model: "sol", effort: "high" },
        ],
      },
      roles: {
        ...roles,
        "ticket-reviewer": {
          ...reviewer,
          list: "changes",
          brief: "roles/ticket-reviewer.md",
          preferOtherAuthorProvider: false,
        },
        "spec-reviewer": {
          ...reviewer,
          list: "specs",
          brief: "roles/spec-reviewer.md",
          preferOtherAuthorProvider: true,
        },
      },
    };
    const merged = decodeManifest(split);
    expect(merged.lists).toEqual(split.lists);
    expect(merged.roles.reviewer.list).toBe("changes");
    expect(merged.roles.reviewer.specList).toBe("specs");
    expect(merged.roles.reviewer.large).toBeUndefined();
    expect(merged.roles.reviewer.preferOtherAuthorProvider).toBe(true);
    expect(encodeManifest(merged).roles).not.toHaveProperty("spec-reviewer");
    expect(encodeManifest(merged).roles).not.toHaveProperty("ticket-reviewer");
    const brief = { hash: "b".repeat(64), text: "Spec rubric" };
    const snapshot = decodeSnapshot({
      hash: "a".repeat(64),
      sourceRevision: "stored",
      manifest: split,
      briefs: Object.fromEntries(
        Object.keys(split.roles).map((name) => [
          name,
          name === "ticket-reviewer" ? { ...brief, text: "Change rubric" } : brief,
        ]),
      ),
    });
    expect(snapshot.briefs.reviewer).toEqual(brief);
    expect(snapshot.manifest).toEqual(merged);
    expect(
      decodeManifestExit({
        ...split,
        roles: {
          ...split.roles,
          "spec-reviewer": { ...split.roles["spec-reviewer"], sourceAccess: "scoped-write" },
        },
      })._tag,
    ).toBe("Failure");
  });

  it("requires a valid specList only on reviewer", () => {
    const manifest = decodeManifest(legacy);
    const edit = (name: "reviewer" | "advisor", extra: object) =>
      decodeManifestExit({
        ...manifest,
        roles: { ...manifest.roles, [name]: { ...manifest.roles[name], ...extra } },
      })._tag;
    expect(edit("reviewer", { specList: undefined })).toBe("Failure");
    expect(edit("reviewer", { specList: "missing" })).toBe("Failure");
    expect(edit("reviewer", { specList: "Invalid Alias" })).toBe("Failure");
    expect(edit("advisor", { specList: "reviewer" })).toBe("Failure");
    expect(manifest.roles.reviewer.specList).toBe(manifest.roles.reviewer.list);
  });

  it("keeps change-role exceptions when old reviewers disagree", () => {
    const current = decodeManifest(legacy);
    const { reviewer, ...roles } = current.roles;
    const change = {
      ...reviewer,
      brief: "roles/ticket-reviewer.md",
      large: { model: "sol", effort: "high" },
      callers: { opus: "sol" },
    };
    const spec = {
      ...reviewer,
      brief: "roles/spec-reviewer.md",
      large: { model: "sonnet", effort: "high" },
      callers: { opus: "sonnet" },
    };
    const merged = decodeManifest({
      ...current,
      roles: { ...roles, "ticket-reviewer": change, "spec-reviewer": spec },
    });
    expect(merged.roles.reviewer.large).toEqual(change.large);
    expect(merged.roles.reviewer.callers).toEqual(change.callers);
    expect(merged.lists).toEqual(current.lists);
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
        lists: {
          ...decodeManifest(legacy).lists,
          researcher: [{ model: "haiku", effort: "high" }],
        },
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

  it("accepts any provider's model and requires effort only where the model has one", () => {
    const manifest = decodeManifest(legacy);
    const withPi = {
      ...manifest,
      models: {
        ...manifest.models,
        deepseek: { driverKind: "pi", model: "deepseek-v4" },
      },
      lists: {
        ...manifest.lists,
        advisor: [...(manifest.lists.advisor ?? []), { model: "deepseek" }],
      },
    };
    expect(decodeManifestExit(withPi)._tag).toBe("Success");
    // A model that offers effort still needs the list entry to choose one.
    expect(
      decodeManifestExit({
        ...manifest,
        lists: {
          ...manifest.lists,
          advisor: (manifest.lists.advisor ?? []).map((entry, index) =>
            index === 0 ? { model: entry.model } : entry,
          ),
        },
      })._tag,
    ).toBe("Failure");
    // The large-task choice follows the same rule.
    expect(
      decodeManifestExit({
        ...manifest,
        roles: {
          ...manifest.roles,
          advisor: {
            ...manifest.roles.advisor,
            large: { model: "haiku" },
          },
        },
      })._tag,
    ).toBe("Failure");
    // A stale effort on a model that lost its effort setting is refused too.
    expect(
      decodeManifestExit({
        ...withPi,
        lists: {
          ...withPi.lists,
          advisor: [...(manifest.lists.advisor ?? []), { model: "deepseek", effort: "high" }],
        },
      })._tag,
    ).toBe("Failure");
  });

  it("reads a stored version 1 snapshot with its reviewer brief", () => {
    const brief = { hash: "b".repeat(64), text: "Brief\n" };
    const snapshot = decodeSnapshot({
      hash: "a".repeat(64),
      sourceRevision: "2026-10-15.2",
      manifest: legacy,
      briefs: Object.fromEntries(Object.keys(legacy.roles).map((name) => [name, brief])),
    });
    expect(snapshot.briefs.reviewer).toEqual(brief);
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

  it("normalizes every stored reviewer request and binding without changing its scope", () => {
    for (const role of ["reviewer", "ticket-reviewer", "spec-reviewer"]) {
      for (const scope of [undefined, "change", "spec"]) {
        const input = {
          ...recorded,
          role,
          ...(scope === undefined ? {} : { review: review(scope) }),
        };
        const request = decodeRequest(input);
        expect(request.role).toBe("reviewer");
        expect(request.review?.scope).toBe(scope);
        const binding = decodeBinding({
          ...input,
          requestFingerprint: "a".repeat(64),
          policyHash: "b".repeat(64),
          policyRevision: "policy",
          briefHash: "c".repeat(64),
          sourceAccess: "read-only",
          toolProfile: "source-reader",
          requested: { instanceId: "codex", model: "model" },
          assigned: null,
          effective: { instanceId: "codex", model: "model" },
        });
        expect(binding.role).toBe("reviewer");
        expect(binding.review?.scope).toBe(scope);
        expect(encodeBinding(binding).role).toBe("reviewer");
      }
    }
  });
});

describe("agentTaskTopic", () => {
  it("drops the role prefix T3 gives a managed task's title", () => {
    expect(agentTaskTopic("Implementation worker · Smoke edit", "implementation-worker")).toBe(
      "Smoke edit",
    );
    expect(agentTaskTopic("Advisor", "advisor")).toBe("");
    expect(agentTaskTopic("Ticket reviewer · Smoke edit", "reviewer")).toBe("Smoke edit");
    expect(agentTaskTopic("Spec reviewer · Smoke edit", "reviewer")).toBe("Smoke edit");
    expect(agentTaskTopic("Reviewer · Smoke edit", "reviewer")).toBe("Smoke edit");
  });

  it("keeps a title that does not start with the role's label", () => {
    expect(agentTaskTopic("Advisor · Smoke edit", "implementation-worker")).toBe(
      "Advisor · Smoke edit",
    );
  });
});

it("retains typed browser selection through the task request wire round trip", () => {
  const input = {
    role: "browser",
    taskClass: "ui",
    workId: "work",
    attemptId: "one",
    workspacePath: "/workspace",
    browser: { backend: "phi", phiLane: "agents" },
  };
  const decoded = decodeRequest(input);
  expect(decoded.browser).toEqual(input.browser);
  expect(decodeRequest(encodeRequest(decoded)).browser).toEqual(input.browser);
  expect(decodeRequest({ ...input, browser: { backend: "integrated" } }).browser).toEqual({
    backend: "integrated",
  });
});
