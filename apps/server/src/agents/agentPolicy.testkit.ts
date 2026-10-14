import {
  AgentPolicySnapshot,
  AgentTaskRequest,
  ServerProvider,
  type AgentRole,
  type AgentModelPool,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const codexModel = "gpt-sol-test";
export const claudeModel = "claude-sonnet-test";
const opusModel = "claude-opus-test";
const decodeSnapshot = Schema.decodeUnknownSync(AgentPolicySnapshot);
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

export function snapshot() {
  const role = (
    name: AgentRole,
    pool: AgentModelPool,
    aliases: string[],
    sourceAccess = "read-only",
    toolProfile = "source-reader",
    taskClasses = ["non-ui"],
    restrictions = {},
  ) => ({
    pool,
    brief: `roles/${name}.md`,
    sourceAccess,
    toolProfile,
    taskClasses,
    restrictions,
    effort: Object.fromEntries(
      aliases.map((alias) => [alias, { default: "medium", demanding: "high" }]),
    ),
  });
  const roles = {
    "chore-worker": role(
      "chore-worker",
      "fast",
      ["luna", "haiku"],
      "scoped-write",
      "implementation",
    ),
    "implementation-worker": role(
      "implementation-worker",
      "workhorse",
      ["sol", "sonnet"],
      "scoped-write",
      "implementation",
    ),
    "ui-worker": role("ui-worker", "ui", ["opus"], "scoped-write", "implementation", [
      "ui",
      "mixed",
    ]),
    browser: role("browser", "fast", ["haiku"], "read-only", "phi", ["ui"], { ui: ["haiku"] }),
    "ui-verifier": role("ui-verifier", "fast", ["haiku"], "read-only", "phi", ["ui"], {
      ui: ["haiku"],
    }),
    advisor: role(
      "advisor",
      "advisor",
      ["astra", "fable"],
      "read-only",
      "source-reader",
      ["non-ui", "ui", "mixed"],
      { ui: ["fable"], mixed: ["fable"] },
    ),
    reviewer: role(
      "reviewer",
      "workhorse",
      ["sol", "sonnet"],
      "read-only",
      "source-reader",
      ["non-ui", "ui", "mixed"],
      { ui: ["sonnet"], mixed: ["sonnet"] },
    ),
  };
  return decodeSnapshot({
    hash: "a".repeat(64),
    sourceRevision: "policy-commit",
    manifest: {
      version: 1,
      revision: "policy-test",
      models: {
        sol: { driverKind: "codex", model: codexModel, effortOption: "reasoning" },
        sonnet: { driverKind: "claudeAgent", model: claudeModel, effortOption: "effort" },
        luna: { driverKind: "codex", model: "gpt-luna-test", effortOption: "reasoning" },
        haiku: { driverKind: "claudeAgent", model: "claude-haiku-test", effortOption: "effort" },
        opus: { driverKind: "claudeAgent", model: opusModel, effortOption: "effort" },
        astra: { driverKind: "codex", model: "gpt-astra-test", effortOption: "reasoning" },
        fable: { driverKind: "claudeAgent", model: "claude-fable-test", effortOption: "effort" },
      },
      pools: {
        fast: { allow: ["luna", "haiku"], prefer: ["haiku", "luna"] },
        workhorse: { allow: ["sol", "sonnet"], prefer: ["sonnet", "sol"] },
        ui: { allow: ["opus"], prefer: ["opus"] },
        advisor: { allow: ["astra", "fable"], prefer: ["fable", "astra"] },
      },
      roles,
    },
    briefs: Object.fromEntries(
      Object.keys(roles).map((name) => [name, { hash: "b".repeat(64), text: `Brief ${name}\n` }]),
    ),
  });
}

export function provider(
  driver: string,
  instanceId: string,
  models: string[],
  efforts = ["medium", "high"],
) {
  return decodeProvider({
    driver,
    instanceId,
    enabled: true,
    installed: true,
    version: "test-version",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: models.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: driver === "codex" ? "reasoning" : "effort",
            label: "Effort",
            type: "select",
            options: efforts.map((id) => ({ id, label: id })),
          },
        ],
      },
    })),
    slashCommands: [],
    skills: [],
  });
}

export const codex = provider("codex", "codex-test", [
  codexModel,
  "gpt-luna-test",
  "gpt-astra-test",
]);
export const claude = provider("claudeAgent", "claude-test", [
  claudeModel,
  opusModel,
  "claude-haiku-test",
  "claude-fable-test",
]);
export const request = (overrides: Partial<AgentTaskRequest> = {}): AgentTaskRequest => ({
  role: "implementation-worker",
  taskClass: "non-ui",
  workId: "work-test",
  attemptId: "attempt-test",
  workspacePath: "/fixture/owned-workspace",
  ...overrides,
});
