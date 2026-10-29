import {
  AgentPolicySnapshot,
  AgentTaskRequest,
  ServerProvider,
  type AgentRole,
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
    list: string,
    sourceAccess = "read-only",
    toolProfile = "source-reader",
    taskClasses = ["non-ui"],
    extra = {},
  ) => ({ list, brief: `roles/${name}.md`, sourceAccess, toolProfile, taskClasses, ...extra });
  const entries = (...models: string[]) => models.map((model) => ({ model, effort: "medium" }));
  const roles = {
    "chore-worker": role("chore-worker", "fast", "scoped-write", "implementation"),
    "implementation-worker": role(
      "implementation-worker",
      "workhorse",
      "scoped-write",
      "implementation",
      ["non-ui"],
      { large: { model: "sol", effort: "high" } },
    ),
    "ui-worker": role("ui-worker", "ui", "scoped-write", "implementation", ["ui", "mixed"]),
    lead: role("lead", "workhorse", "scoped-write", "implementation", ["non-ui", "ui", "mixed"]),
    browser: role("browser", "browser", "read-only", "phi", ["ui"]),
    "ui-verifier": role("ui-verifier", "browser", "read-only", "phi", ["ui"]),
    advisor: role("advisor", "advisor", "read-only", "source-reader", ["non-ui", "ui", "mixed"], {
      callers: { opus: "astra" },
    }),
    "ticket-reviewer": role(
      "ticket-reviewer",
      "workhorse",
      "read-only",
      "source-reader",
      ["non-ui", "ui", "mixed"],
      { preferOtherAuthorProvider: true },
    ),
    "spec-reviewer": role(
      "spec-reviewer",
      "workhorse",
      "read-only",
      "source-reader",
      ["non-ui", "ui", "mixed"],
      { preferOtherAuthorProvider: true },
    ),
  };
  return decodeSnapshot({
    hash: "a".repeat(64),
    sourceRevision: "policy-commit",
    manifest: {
      version: 2,
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
      lists: {
        fast: entries("haiku", "luna"),
        workhorse: entries("sonnet", "sol"),
        ui: entries("opus"),
        browser: entries("haiku"),
        advisor: entries("fable", "astra"),
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
    nativeWebResearch: ["codex", "claudeAgent"].includes(driver),
    readOnlySourceAccess: ["codex", "claudeAgent", "pi"].includes(driver) ? "enforced" : undefined,
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
/** A change review of one landing, the common reviewer fixture. */
export const changeReview: NonNullable<AgentTaskRequest["review"]> = {
  scope: "change",
  baseRevision: "base-commit",
  includedChanges: ["reviewed-commit"],
  coverage: "complete",
};

export const request = (overrides: Partial<AgentTaskRequest> = {}): AgentTaskRequest => ({
  role: "implementation-worker",
  taskClass: "non-ui",
  workId: "work-test",
  attemptId: "attempt-test",
  workspacePath: "/fixture/owned-workspace",
  ...overrides,
});
