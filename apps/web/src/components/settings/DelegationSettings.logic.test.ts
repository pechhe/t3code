import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { AgentPolicyManifest, ServerProvider } from "@t3tools/contracts";
import {
  catalogModels,
  effortFor,
  effortForModel,
  ensureModel,
  isUiOnly,
  listModel,
  offersFast,
  removeEntry,
  replaceEntry,
  roleGroups,
  runsFast,
  setCaller,
  setModelFast,
  splitGroup,
  unavailableReason,
} from "./DelegationSettings.logic";

const decodeManifest = Schema.decodeUnknownSync(AgentPolicyManifest);
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const isValid = Schema.is(AgentPolicyManifest);

const role = (list: string, extra: object = {}) => ({
  list,
  sourceAccess: "read-only",
  toolProfile: "source-reader",
  taskClasses: ["non-ui"],
  ...extra,
});
const manifest = () =>
  decodeManifest({
    version: 2,
    revision: "fixture.1",
    models: {
      haiku: { driverKind: "claudeAgent", model: "claude-haiku", effortOption: "effort" },
      sol: { driverKind: "codex", model: "gpt-sol", effortOption: "reasoning" },
      opus: { driverKind: "claudeAgent", model: "claude-opus", effortOption: "effort" },
    },
    lists: {
      fast: [
        { model: "haiku", effort: "high" },
        { model: "sol", effort: "high" },
      ],
      workhorse: [{ model: "sol", effort: "medium" }],
      advisor: [
        { model: "sol", effort: "high" },
        { model: "opus", effort: "high" },
      ],
    },
    roles: {
      "chore-worker": role("fast", {
        brief: "roles/chore-worker.md",
        sourceAccess: "scoped-write",
        toolProfile: "implementation",
      }),
      browser: role("fast", { brief: "roles/browser.md", toolProfile: "phi" }),
      "ui-verifier": role("fast", { brief: "roles/ui-verifier.md", toolProfile: "phi" }),
      "implementation-worker": role("workhorse", {
        brief: "roles/implementation-worker.md",
        sourceAccess: "scoped-write",
        toolProfile: "implementation",
      }),
      "ui-worker": role("advisor", {
        brief: "roles/ui-worker.md",
        sourceAccess: "scoped-write",
        toolProfile: "implementation",
        taskClasses: ["ui"],
      }),
      advisor: role("advisor", {
        brief: "roles/advisor.md",
        large: { model: "opus", effort: "max" },
        callers: { haiku: "opus" },
      }),
      "ticket-reviewer": role("workhorse", { brief: "roles/ticket-reviewer.md" }),
      "spec-reviewer": role("advisor", { brief: "roles/spec-reviewer.md" }),
    },
  });

const provider = (overrides: object = {}) =>
  decodeProvider({
    driver: "claudeAgent",
    instanceId: "claude",
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-15T00:00:00.000Z",
    models: [
      {
        slug: "claude-opus",
        name: "Opus",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [{ id: "medium", label: "Medium" }],
            },
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
    ...overrides,
  });

describe("delegation settings", () => {
  it("shows roles that share a list as one job, in page order", () => {
    expect(roleGroups(manifest()).map((group) => group.roles)).toEqual([
      ["implementation-worker", "ticket-reviewer"],
      ["ui-worker", "spec-reviewer", "advisor"],
      ["chore-worker", "browser", "ui-verifier"],
    ]);
  });

  it("splitting a shared job gives each role its own copy and stays valid", () => {
    const original = manifest();
    const group = roleGroups(original).find((candidate) => candidate.list === "fast")!;
    const split = splitGroup(original, group);
    expect(isValid(split)).toBe(true);
    expect(split.roles.browser.list).toBe("browser");
    expect(split.lists["browser"]).toEqual(original.lists["fast"]);
    expect(split.lists["fast"]).toBeUndefined();
    expect(roleGroups(split)).toHaveLength(5);
  });

  it("removing a model drops the exceptions that named it", () => {
    const next = removeEntry(manifest(), "advisor", "opus");
    expect(next.roles.advisor.large).toBeUndefined();
    expect(next.roles.advisor.callers).toBeUndefined();
    expect(isValid(next)).toBe(true);
    // Removing the last model leaves a job that cannot be saved.
    expect(isValid(removeEntry(next, "workhorse", "sol"))).toBe(false);
  });

  it("names a newly picked model with a valid alias once", () => {
    const [model] = catalogModels([provider()]);
    const [first, alias] = ensureModel(manifest(), model!);
    expect(alias).toBe("opus");
    const fresh = { ...model!, binding: { ...model!.binding, model: "Claude Fable 5.1" } };
    const [next, created] = ensureModel(first, fresh);
    expect(created).toBe("m-claude-fable-5-1");
    expect(ensureModel(next, fresh)[1]).toBe(created);
    expect(isValid(setCaller(next, "advisor", created, "opus"))).toBe(true);
  });

  it("swapping a listed model keeps its place and the exceptions that named it", () => {
    const [model] = catalogModels([provider()]);
    const fable = { ...model!, binding: { ...model!.binding, model: "claude-fable" } };
    const next = replaceEntry(manifest(), "advisor", "opus", fable, "medium");
    const alias = next.lists["advisor"]![1]!.model;
    expect(next.models[alias]?.model).toBe("claude-fable");
    expect(next.lists["advisor"]![1]!.effort).toBe("medium");
    expect(next.roles.advisor.large?.model).toBe(alias);
    expect(next.roles.advisor.callers).toEqual({ haiku: alias });
    expect(isValid(next)).toBe(true);
    // A model already in the list is not listed twice.
    const sol = { ...model!, binding: manifest().models.sol! };
    expect(replaceEntry(manifest(), "advisor", "opus", sol, "high")).toEqual(manifest());
  });

  it("turns fast on and off for a model without leaving an empty options map", () => {
    const fast = setModelFast(manifest(), "sol", true);
    expect(fast.models["sol"]!.options).toEqual({ serviceTier: "fast" });
    expect(runsFast(fast.models["sol"])).toBe(true);
    expect(setModelFast(fast, "sol", false).models["sol"]).toEqual(manifest().models["sol"]);
  });

  it("offers fast only when the account's model has the fast tier", () => {
    const tiered = provider({
      driver: "codex",
      models: [
        {
          slug: "gpt-sol",
          name: "Sol",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "serviceTier",
                label: "Service Tier",
                type: "select",
                options: [
                  { id: "default", label: "Standard" },
                  { id: "fast", label: "Fast" },
                ],
              },
            ],
          },
        },
      ],
    });
    const sol = manifest().models["sol"];
    expect(offersFast(sol, [tiered])).toBe(true);
    expect(offersFast(sol, [])).toBe(false);
    expect(offersFast(manifest().models["opus"], [tiered])).toBe(false);
  });

  it("lists a large-task or per-agent choice the job did not list yet, last", () => {
    const [model] = catalogModels([provider()]);
    const [next, alias] = listModel(manifest(), "workhorse", model!, "medium");
    expect(alias).toBe("opus");
    expect(next.lists["workhorse"]!.map((entry) => entry.model)).toEqual(["sol", "opus"]);
    expect(listModel(next, "workhorse", model!, "high")[0]).toEqual(next);
  });

  it("explains why a model cannot take work now", () => {
    const opus = manifest().models.opus;
    expect(unavailableReason(opus, [provider()])).toBeNull();
    expect(unavailableReason(opus, [])).toBe("not installed");
    expect(unavailableReason(opus, [provider({ auth: { status: "unauthenticated" } })])).toBe(
      "signed out",
    );
    const limited = provider({
      usageLimits: {
        checkedAt: "2026-10-15T00:00:00.000Z",
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 100,
            resetsAt: "2026-10-15T05:00:00.000Z",
          },
        ],
      },
    });
    expect(unavailableReason(opus, [limited], { now: Date.parse("2026-10-15T01:00:00Z") })).toBe(
      "rate limited",
    );
    // Any one usable account is enough.
    expect(unavailableReason(opus, [limited, provider({ instanceId: "claude-2" })])).toBeNull();
  });

  it("never offers an OpenAI model to a row that only takes UI work", () => {
    const policy = manifest();
    const sol = policy.models.sol;
    const codex = provider({
      driver: "codex",
      instanceId: "codex",
      models: [{ slug: "gpt-sol", name: "Sol", isCustom: false, capabilities: null }],
    });
    expect(isUiOnly(policy, ["ui-worker"])).toBe(true);
    expect(isUiOnly(policy, ["ui-worker", "advisor"])).toBe(false);
    expect(unavailableReason(sol, [codex], { uiOnly: true })).toBe("not used for UI work");
    expect(unavailableReason(sol, [codex])).toBeNull();
  });

  it("keeps an effort the new model offers, else falls back to one it does", () => {
    expect(effortFor(["low", "medium", "high"], "high")).toBe("high");
    expect(effortFor(["low", "medium", "high"], "xhigh")).toBe("medium");
    expect(effortFor(["low", "high"], "xhigh")).toBe("low");
    // With no installed account the choices are unknown, so the current effort stands.
    expect(effortFor([], "xhigh")).toBe("xhigh");
  });

  it("lists every installed provider's models and records effort only where there is one", () => {
    const pi = decodeProvider({
      ...provider(),
      driver: "pi",
      instanceId: "pi",
      models: [
        {
          slug: "deepseek-v4",
          name: "DeepSeek V4.1 Flash",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
        {
          slug: "kimi-k2",
          name: "Kimi K2",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "thinking",
                label: "Thinking",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                ],
              },
            ],
          },
        },
      ],
    });
    const [deepseek, kimi] = catalogModels([pi]);
    expect(deepseek).toMatchObject({
      label: "DeepSeek V4.1 Flash",
      binding: { driverKind: "pi", model: "deepseek-v4" },
      efforts: [],
    });
    expect(deepseek!.binding.effortOption).toBeUndefined();
    expect(effortForModel(deepseek!)).toBeUndefined();
    expect(kimi).toMatchObject({
      binding: { driverKind: "pi", model: "kimi-k2", effortOption: "thinking" },
      efforts: ["low", "medium"],
    });
    expect(effortForModel(kimi!)).toBe("medium");
  });
});
