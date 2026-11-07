import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { AgentPolicyManifest, ServerProvider } from "@t3tools/contracts";
import {
  catalogModels,
  councilIssue,
  councilSeating,
  councilMembers,
  councilOn,
  effortFor,
  effortForModel,
  ensureModel,
  jobsFor,
  listModel,
  offersFast,
  readOnlyUnenforcedProviders,
  removeEntry,
  replaceEntry,
  roleGroups,
  editableManifest,
  runsFast,
  setCaller,
  setCouncil,
  setModelFast,
  setModelOptions,
  splitGroup,
  splitJob,
  unavailableReason,
} from "./DelegationSettings.logic";

const decodeManifest = Schema.decodeUnknownSync(AgentPolicyManifest);
const encodeManifest = Schema.encodeSync(AgentPolicyManifest);
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
      reviewer: role("workhorse", { brief: "roles/reviewer.md", specList: "workhorse" }),
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
  it("edits and saves both reviewer lists without dropping their bindings", () => {
    const original = manifest();
    const separate = {
      ...original,
      roles: { ...original.roles, reviewer: { ...original.roles.reviewer, specList: "advisor" } },
    };
    const group = roleGroups(separate).find((candidate) => candidate.list === "advisor")!;
    expect(group.bindings).toContainEqual({ role: "reviewer", field: "specList" });
    const split = splitGroup(separate, group);
    expect(split.roles.reviewer.list).toBe("workhorse");
    expect(split.roles.reviewer.specList).toBe("reviewer-spec");
    expect(split.lists["reviewer-spec"]).toEqual(original.lists.advisor);
    const edited = removeEntry(split, "reviewer-spec", "sol");
    const saved = decodeManifest(encodeManifest(edited));
    expect(saved).toEqual(edited);
    expect(saved.lists.workhorse).toEqual(original.lists.workhorse);
    expect(saved.lists["reviewer-spec"]).toEqual([{ model: "opus", effort: "high" }]);
    expect(isValid(removeEntry(saved, "reviewer-spec", "opus"))).toBe(false);
  });

  it("shows the Reviewer as one job with a change list and a Spec list", () => {
    const original = manifest();
    const separate = {
      ...original,
      roles: { ...original.roles, reviewer: { ...original.roles.reviewer, specList: "advisor" } },
    };
    for (const policy of [separate]) {
      const jobs = jobsFor(policy, roleGroups(policy));
      const reviewers = jobs.filter((job) => job.roles.includes("reviewer"));
      expect(reviewers).toHaveLength(1);
      expect(reviewers[0]!.roles).toEqual(["reviewer"]);
      expect(reviewers[0]!.sections.map((section) => section.title)).toEqual([
        "Change reviews",
        "Spec reviews",
      ]);
      expect(reviewers[0]!.sections.map((section) => section.list)).toEqual([
        "workhorse",
        policy.roles.reviewer.specList,
      ]);
      expect(jobs.flatMap((job) => job.roles).toSorted()).toEqual(
        Object.keys(policy.roles).toSorted(),
      );
    }
  });

  it("edits a list both reviews share once, and names other roles on a Reviewer list", () => {
    const original = manifest();
    const policy = {
      ...original,
      roles: {
        ...original.roles,
        reviewer: { ...original.roles.reviewer, list: "workhorse", specList: "workhorse" },
      },
    };
    const job = jobsFor(policy, roleGroups(policy)).find((candidate) =>
      candidate.roles.includes("reviewer"),
    )!;
    expect(job.sections.map((section) => section.title)).toEqual(["Change and Spec reviews"]);
    expect(job.sections[0]!.hint).toContain("Also used by Implementation worker");
    expect(job.splitGroups.map((group) => group.list)).toEqual(["workhorse"]);
  });

  it("splitting the Reviewer job leaves separate lists for it and for the roles it shared with", () => {
    const original = manifest();
    const job = jobsFor(original, roleGroups(original)).find((candidate) =>
      candidate.roles.includes("reviewer"),
    )!;
    const split = splitJob(original, job);
    expect(isValid(split)).toBe(true);
    expect(split.roles.reviewer.list).toBe("reviewer");
    expect(split.roles.reviewer.specList).toBe("reviewer-spec");
    expect(split.roles["implementation-worker"].list).toBe("implementation-worker");
  });

  it("splits both reviewer bindings when the scopes share a list", () => {
    const original = manifest();
    const group = roleGroups(original).find((candidate) => candidate.list === "workhorse")!;
    const split = splitGroup(original, group);
    expect(split.roles.reviewer.list).toBe("reviewer");
    expect(split.roles.reviewer.specList).toBe("reviewer-spec");
    expect(isValid(split)).toBe(true);
  });

  it("names only enabled providers that do not declare read-only enforcement", () => {
    expect(
      readOnlyUnenforcedProviders([
        provider({ readOnlySourceAccess: "enforced" }),
        provider({ driver: "cursor", instanceId: "cursor", displayName: "Cursor" }),
        provider({ driver: "muse", instanceId: "muse", displayName: "Muse", enabled: false }),
        provider({ driver: "grok", instanceId: "grok" }),
        provider({ driver: "cursor", instanceId: "cursor-2", displayName: "Cursor" }),
        provider({ instanceId: "pool", poolMembers: ["claude"] }),
      ]),
    ).toEqual(["Cursor", "grok"]);
    expect(readOnlyUnenforcedProviders([provider({ readOnlySourceAccess: "enforced" })])).toEqual(
      [],
    );
  });

  it("shows roles that share a list as one job, in page order, and edits no ui-verifier", () => {
    expect(roleGroups(manifest()).map((group) => group.roles)).toEqual([
      ["implementation-worker", "reviewer"],
      ["ui-worker", "advisor"],
      ["chore-worker", "browser"],
    ]);
    const saved = manifest();
    const retired = {
      ...saved,
      roles: {
        ...saved.roles,
        "ui-verifier": { ...saved.roles.browser, brief: "roles/ui-verifier.md" },
      },
    };
    expect(editableManifest(retired)).toEqual(saved);
  });

  it("splitting a shared job gives each role its own copy and stays valid", () => {
    const original = manifest();
    const group = roleGroups(original).find((candidate) => candidate.list === "fast")!;
    const split = splitGroup(original, group);
    expect(isValid(split)).toBe(true);
    expect(split.roles.browser.list).toBe("browser");
    expect(split.lists["browser"]).toEqual(original.lists["fast"]);
    expect(split.lists["fast"]).toBeUndefined();
    expect(roleGroups(split)).toHaveLength(4);
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

  it("stores a trait picked in the effort menu as the model's fixed option", () => {
    // The service tier belongs to the model, while effort belongs to the job's list entry.
    const standard = setModelOptions(manifest(), "sol", [
      { id: "reasoning", value: "high" },
      { id: "serviceTier", value: "default" },
    ]);
    expect(standard.models["sol"]!.options).toEqual({ serviceTier: "default" });
    expect(runsFast(standard.models["sol"])).toBe(false);
    // Picking only effort leaves no fixed options behind.
    expect(
      setModelOptions(standard, "sol", [{ id: "reasoning", value: "low" }]).models["sol"],
    ).toEqual(manifest().models["sol"]);
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

  describe("council", () => {
    const separate = () => {
      const base = manifest();
      return {
        ...base,
        lists: {
          ...base.lists,
          "reviewer-spec": [
            { model: "sol", effort: "high" },
            { model: "opus", effort: "high" },
          ],
        },
        roles: {
          ...base.roles,
          reviewer: { ...base.roles.reviewer, specList: "reviewer-spec" },
        },
      };
    };

    it("reads an older policy without council as Off", () => {
      expect(councilOn(manifest())).toBe(false);
      expect(councilIssue(manifest())).toBeNull();
    });

    it("turning it On stores true, and Off removes the key", () => {
      const on = setCouncil(manifest(), true);
      expect(on.roles.reviewer.council).toBe(true);
      expect(councilOn(on)).toBe(true);
      expect(isValid(encodeManifest(on))).toBe(true);
      const off = setCouncil(on, false);
      expect("council" in off.roles.reviewer).toBe(false);
      expect(encodeManifest(off)).toEqual(encodeManifest(manifest()));
    });

    it("names each Spec-review member's maker", () => {
      expect(councilMembers(separate()).map(({ model, maker }) => [model, maker])).toEqual([
        ["sol", "openai"],
        ["opus", "anthropic"],
      ]);
    });

    it("says how many makers can sit now, and when the council will not form", () => {
      const on = setCouncil(separate(), true);
      // Only the Claude account is installed, so OpenAI's member cannot sit.
      expect(councilSeating(on, [provider()])).toBe(
        "1 of 2 makers can sit now: the council won't form until another maker is available, so one reviewer runs.",
      );
      expect(councilSeating(on, [])).toMatch(/^0 of 2 makers can sit now/);
    });

    it("needs at least two distinct makers while On", () => {
      const two = setCouncil(separate(), true);
      expect(councilIssue(two)).toBeNull();
      const one = removeEntry(two, "reviewer-spec", "opus");
      expect(councilIssue(one)).toMatch(/at least two makers/);
      expect(councilIssue(setCouncil(one, false))).toBeNull();
      const sameMaker = replaceEntry(
        two,
        "reviewer-spec",
        "sol",
        catalogModels([
          provider({
            models: [{ slug: "claude-haiku", name: "Haiku", isCustom: false, capabilities: null }],
          }),
        ])[0]!,
        undefined,
      );
      expect(councilIssue(sameMaker)).toMatch(/at least two makers/);
    });
  });
});
