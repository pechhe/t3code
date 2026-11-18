import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  AgentPolicyManifest,
  type AgentPolicySettings,
  EnvironmentId,
  ModelPoolId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import {
  addEntry,
  catalogModels,
  listedModels,
  poolNote,
  councilIssue,
  councilSeating,
  councilMembers,
  councilOn,
  effortFor,
  effortForModel,
  ensureModel,
  jobsFor,
  listModel,
  modelDefaultStance,
  moveEntry,
  offersFast,
  poolDefaultStance,
  readOnlyUnenforcedProviders,
  removeEntry,
  replaceEntry,
  roleGroups,
  editableManifest,
  runsFast,
  savePolicyToTargets,
  setCaller,
  setEntryEffort,
  setCouncil,
  setModelDefaultStance,
  setModelListedOnly,
  modelListedOnly,
  setModelFast,
  setModelNote,
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
      workhorse: [{ model: "sol", effort: "medium" }],
      advisor: [
        { model: "sol", effort: "high" },
        { model: "opus", effort: "high" },
      ],
      readers: [
        { model: "haiku", effort: "high" },
        { model: "opus", effort: "high" },
      ],
    },
    roles: {
      implementer: role("workhorse", {
        brief: "roles/implementer.md",
        sourceAccess: "scoped-write",
        toolProfile: "implementation",
        taskClasses: ["non-ui", "ui", "mixed"],
      }),
      browser: role("readers", { brief: "roles/browser.md", toolProfile: "phi" }),
      researcher: role("readers", { brief: "roles/researcher.md", toolProfile: "web-research" }),
      scout: role("readers", { brief: "roles/scout.md" }),
      advisor: role("advisor", {
        brief: "roles/advisor.md",
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

/** An environment's policy file: a save must name its current hash, as the server requires. */
const policyStore = (initial: AgentPolicyManifest) => {
  let writes = 0;
  const store = {
    manifest: initial,
    hash: "h0",
    settings: (): AgentPolicySettings =>
      ({
        snapshot: {
          hash: store.hash,
          sourceRevision: store.manifest.revision,
          manifest: store.manifest,
          briefs: {},
        },
        sourceRoot: "/agent-config",
        uncommitted: false,
        providers: [],
      }) as unknown as AgentPolicySettings,
    save: async (expectedHash: string, next: AgentPolicyManifest) => {
      if (expectedHash !== store.hash)
        return { ok: false as const, message: "The policy changed on disk.", stale: true };
      writes += 1;
      store.manifest = { ...next, revision: `fixture.${writes + 1}` };
      store.hash = `h${writes}`;
      return { ok: true as const, settings: store.settings() };
    },
  };
  return store;
};

describe("delegation settings", () => {
  it("saves every edit to environments that share one policy", async () => {
    // Two machines on one agent-config: whatever one writes, the other then holds.
    const shared = policyStore(manifest());
    const targets = [
      { environmentId: EnvironmentId.make("mac"), label: "Mac", hash: shared.hash },
      { environmentId: EnvironmentId.make("vps"), label: "VPS", hash: shared.hash },
    ];
    const hashes = new Map(targets.map((target) => [target.environmentId, target.hash]));
    const saveTo = (next: AgentPolicyManifest) =>
      savePolicyToTargets({
        manifest: next,
        targets,
        hashes,
        save: (_target, expectedHash, manifest) => shared.save(expectedHash, manifest),
        read: async () => shared.settings(),
      });
    const first = removeEntry(manifest(), "readers", "opus");
    expect(await saveTo(first)).toEqual({ failure: null, notPushed: [] });
    const second = removeEntry(first, "advisor", "opus");
    expect(await saveTo(second)).toEqual({ failure: null, notPushed: [] });
    expect(shared.manifest.lists).toEqual(second.lists);
    expect([...hashes.values()]).toEqual([shared.hash, shared.hash]);
  });

  it("still refuses an environment whose policy changed to something else", async () => {
    const mac = policyStore(manifest());
    const vps = policyStore(manifest());
    const targets = [
      { environmentId: EnvironmentId.make("mac"), label: "Mac", hash: "h0" },
      { environmentId: EnvironmentId.make("vps"), label: "VPS", hash: "h0" },
    ];
    await vps.save("h0", removeEntry(manifest(), "advisor", "sol"));
    const edit = removeEntry(manifest(), "readers", "opus");
    const outcome = await savePolicyToTargets({
      manifest: edit,
      targets,
      hashes: new Map(),
      save: (target, expectedHash) => (target.label === "Mac" ? mac : vps).save(expectedHash, edit),
      read: async (target) => (target.label === "Mac" ? mac : vps).settings(),
    });
    expect(outcome.failure).toBe("VPS: The policy changed on disk.");
    expect(vps.manifest.lists.advisor).toEqual([{ model: "opus", effort: "high" }]);
  });

  it("reports a refusal that needs repair even when the policy already holds the edit", async () => {
    const shared = policyStore(manifest());
    const edit = removeEntry(manifest(), "readers", "opus");
    await shared.save("h0", edit);
    const message =
      "The policy folder is out of step with the shared copy and could not be updated.";
    const outcome = await savePolicyToTargets({
      manifest: edit,
      targets: [{ environmentId: EnvironmentId.make("vps"), label: "VPS", hash: "h0" }],
      hashes: new Map(),
      save: async () => ({ ok: false, message, stale: false }),
      read: async () => shared.settings(),
    });
    expect(outcome.failure).toBe(message);
  });

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
    expect(job.sections[0]!.hint).toContain("Also used by Implementer");
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
    expect(split.roles.implementer.list).toBe("implementer");
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
      ["implementer", "reviewer"],
      ["advisor"],
      ["browser", "researcher", "scout"],
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
    const group = roleGroups(original).find((candidate) => candidate.list === "readers")!;
    const split = splitGroup(original, group);
    expect(isValid(split)).toBe(true);
    expect(split.roles.browser.list).toBe("browser");
    expect(split.lists["browser"]).toEqual(original.lists["readers"]);
    expect(split.lists["readers"]).toBeUndefined();
    expect(roleGroups(split)).toHaveLength(5);
  });

  it("edits a list several roles share once, so every role naming it follows", () => {
    const original = manifest();
    const job = jobsFor(original, roleGroups(original)).find((candidate) =>
      candidate.roles.includes("scout"),
    )!;
    expect(job.roles).toEqual(["browser", "researcher", "scout"]);
    expect(job.sections.map((section) => section.list)).toEqual(["readers"]);
    // The one list the job shows is the list all three roles read, so a reorder reaches all three.
    const edited = moveEntry(original, job.sections[0]!.list, 0, 1);
    expect(edited.lists["readers"]!.map((entry) => entry.model)).toEqual(["opus", "haiku"]);
    for (const role of ["browser", "researcher", "scout"] as const)
      expect(edited.lists[edited.roles[role]!.list]).toEqual(edited.lists["readers"]);
    // Removing a model from it reaches them too, and leaves one shared list rather than three.
    const removed = removeEntry(edited, "readers", "haiku");
    expect(isValid(removed)).toBe(true);
    expect(roleGroups(removed)).toHaveLength(3);
    expect(removed.lists["readers"]).toEqual([{ model: "opus", effort: "high" }]);
  });

  it("removing a model drops the exceptions that named it", () => {
    const next = removeEntry(manifest(), "advisor", "opus");
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
    expect(next.roles.advisor.callers).toEqual({ haiku: alias });
    expect(isValid(next)).toBe(true);
    // A model already in the list is not listed twice.
    const sol = { ...model!, binding: manifest().models.sol! };
    expect(replaceEntry(manifest(), "advisor", "opus", sol, "high")).toEqual(manifest());
  });

  it("keeps one note per model, on every alias that binds it", () => {
    const base = manifest();
    const twin = { ...base, models: { ...base.models, "opus-pi": { ...base.models.opus! } } };
    const noted = setModelNote(twin, "claude-opus", "  Strongest; design work ");
    expect(noted.models.opus!.note).toBe("Strongest; design work");
    expect(noted.models["opus-pi"]!.note).toBe("Strongest; design work");
    // The same model on another account is a new alias that inherits the note.
    const [model] = catalogModels([provider()]);
    const elsewhere = {
      ...model!,
      binding: { ...model!.binding, driverKind: ProviderDriverKind.make("pi") },
    };
    const [listed, alias] = ensureModel(noted, elsewhere);
    expect(alias).not.toBe("opus");
    expect(listed.models[alias]!.note).toBe("Strongest; design work");
    expect(setModelNote(noted, "claude-opus", "").models.opus).toEqual(base.models.opus);

    const stanced = setModelDefaultStance(twin, "claude-opus", "orchestrate");
    expect(modelDefaultStance(stanced, "claude-opus")).toBe("orchestrate");
    expect(stanced.models.opus!.defaultStance).toBe("orchestrate");
    expect(stanced.models["opus-pi"]!.defaultStance).toBe("orchestrate");
    expect(ensureModel(stanced, elsewhere)[0].models[alias]!.defaultStance).toBe("orchestrate");
    const unset = setModelDefaultStance(stanced, "claude-opus", undefined);
    expect(modelDefaultStance(unset, "claude-opus")).toBeUndefined();
    expect(unset.models.opus).toEqual(base.models.opus);

    const kept = setModelListedOnly(twin, "claude-opus", true);
    expect(modelListedOnly(kept, "claude-opus")).toBe(true);
    expect(kept.models["opus-pi"]!.listedOnly).toBe(true);
    expect(ensureModel(kept, elsewhere)[0].models[alias]!.listedOnly).toBe(true);
    expect(setModelListedOnly(kept, "claude-opus", false).models.opus).toEqual(base.models.opus);
  });

  it("joins a model pool and its listed member slots into one row with one shared note", () => {
    const poolId = ModelPoolId.make("opus");
    const modelPools = {
      [poolId]: {
        displayName: "Opus 5.5",
        slots: [
          { providerInstanceId: ProviderInstanceId.make("pi"), model: "hf/claude-opus" },
          { providerInstanceId: ProviderInstanceId.make("claude"), model: "claude-opus" },
        ],
      },
    };
    const base = manifest();
    // A member slot listed on its own already carries a note; a Pi slot of the pool is listed too.
    const listedSlot = {
      ...setModelNote(base, "claude-opus", "Strongest; design work"),
    };
    const withPiSlot = addEntry(
      {
        ...listedSlot,
        models: {
          ...listedSlot.models,
          "pi-opus": { driverKind: ProviderDriverKind.make("pi"), model: "hf/claude-opus" },
        },
      },
      "workhorse",
      { model: "pi-opus" },
    );
    const pool = catalogModels([provider()], modelPools).find(
      (candidate) => candidate.poolId === poolId,
    )!;
    expect(pool.binding).toMatchObject({ driverKind: "claudeAgent", model: "claude-opus", poolId });
    const [withPool, poolAlias] = listModel(withPiSlot, "readers", pool, "medium", modelPools);
    // Forming the pool carries the slot's note forward.
    expect(withPool.models[poolAlias]!.note).toBe("Strongest; design work");
    expect(isValid(withPool)).toBe(true);

    const rows = listedModels(withPool, jobsFor(withPool, roleGroups(withPool)), modelPools);
    const poolRows = rows.filter((row) => row.poolId === poolId);
    expect(poolRows).toHaveLength(1);
    expect(poolRows[0]!.alias).toBe(poolAlias);
    expect(poolRows[0]!.roles).toEqual(
      expect.arrayContaining(["implementer", "advisor", "browser", "researcher", "scout"]),
    );
    expect(rows.some((row) => row.model === "claude-opus" || row.model === "hf/claude-opus")).toBe(
      false,
    );

    const renoted = setModelNote(withPool, `pool:${poolId}`, "Use for hard design", modelPools);
    expect(poolNote(renoted, poolId, modelPools)).toBe("Use for hard design");
    for (const alias of [poolAlias, "opus", "pi-opus"])
      expect(renoted.models[alias]!.note).toBe("Use for hard design");
    expect(renoted.models.haiku!.note).toBeUndefined();

    const poolStanced = setModelDefaultStance(renoted, `pool:${poolId}`, "implement", modelPools);
    expect(poolDefaultStance(poolStanced, poolId, modelPools)).toBe("implement");
    for (const alias of [poolAlias, "opus", "pi-opus"])
      expect(poolStanced.models[alias]!.defaultStance).toBe("implement");
    expect(poolStanced.models.haiku!.defaultStance).toBeUndefined();

    // Once a second pool also lists the Claude slot, that slot no longer belongs to either pool's note.
    const twoPools = {
      ...modelPools,
      [ModelPoolId.make("claude-only")]: {
        displayName: "Claude only",
        slots: [{ providerInstanceId: ProviderInstanceId.make("claude"), model: "claude-opus" }],
      },
    };
    const scoped = setModelNote(withPool, `pool:${poolId}`, "Pool note", twoPools);
    expect(scoped.models.opus!.note).toBe("Strongest; design work");
    expect(scoped.models["pi-opus"]!.note).toBe("Pool note");
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

  it("lists a per-agent choice the job did not list yet, last", () => {
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
    // An account the user assumes has usage left is never rate limited.
    const assumed = provider({
      usageLimits: { ...limited.usageLimits!, assumedAvailable: true },
    });
    expect(
      unavailableReason(opus, [assumed], { now: Date.parse("2026-10-15T01:00:00Z") }),
    ).toBeNull();
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

  it("recognises ACP reasoning controls and repairs existing bindings in every job", () => {
    const antigravity = decodeProvider({
      ...provider(),
      driver: "antigravity",
      instanceId: "antigravity",
      models: [
        {
          slug: "gemini-hydrogen",
          name: "Gemini Hydrogen",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "thought_level",
                label: "Thinking level",
                role: "reasoning",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                  { id: "xhigh", label: "X-High" },
                ],
              },
            ],
          },
        },
      ],
    });
    const catalog = catalogModels([antigravity]);
    expect(catalog[0]).toMatchObject({
      binding: { effortOption: "thought_level" },
      efforts: ["low", "medium", "high", "xhigh"],
    });
    const original = manifest();
    const existing = {
      ...original,
      models: {
        ...original.models,
        hydrogen: { driverKind: ProviderDriverKind.make("antigravity"), model: "gemini-hydrogen" },
      },
      lists: {
        ...original.lists,
        writers: [{ model: "hydrogen" }],
        readers: [{ model: "hydrogen" }],
      },
    };
    const edited = editableManifest(existing, catalog);
    expect(edited.models.hydrogen?.effortOption).toBe("thought_level");
    expect(edited.lists.writers).toEqual([{ model: "hydrogen", effort: "medium" }]);
    expect(edited.lists.readers).toEqual([{ model: "hydrogen", effort: "medium" }]);
    expect(decodeManifest(encodeManifest(edited))).toEqual(edited);
    const highest = setEntryEffort(edited, "writers", "hydrogen", "xhigh");
    expect(decodeManifest(encodeManifest(highest)).lists.writers).toEqual([
      { model: "hydrogen", effort: "xhigh" },
    ]);
    expect(editableManifest(edited, catalog)).toEqual(edited);
    expect(editableManifest(existing).models.hydrogen).toEqual(existing.models.hydrogen);
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
