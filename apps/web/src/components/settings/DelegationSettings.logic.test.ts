import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  AccountId,
  AgentPolicyManifest,
  type AgentPolicySettings,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { multiAccountModels, pooledModels } from "@t3tools/shared/accountPools";
import {
  addEntry,
  bindingInstance,
  catalogModels,
  listedModels,
  pooledNote,
  effortFor,
  effortForModel,
  ensureModel,
  isAnyAccountBinding,
  jobsFor,
  listModel,
  matchesCatalogModel,
  modelDefaultStance,
  modelLabel,
  offersFast,
  pooledDefaultStance,
  readOnlyUnenforcedProviders,
  removeEntry,
  replaceEntry,
  reviewerWrapUpToolCalls,
  roleGroups,
  editableManifest,
  runsFast,
  savePolicyToTargets,
  setCaller,
  setEntryEffort,
  setModelDefaultStance,
  setModelListedOnly,
  modelListedOnly,
  setModelFast,
  setModelNote,
  setModelOptions,
  setReviewerWrapUpToolCalls,
  splitGroup,
  splitJob,
  unavailableReason,
  withBoundModel,
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
      scout: role("readers", { brief: "roles/scout.md", toolProfile: "web-research" }),
      advisor: role("advisor", {
        brief: "roles/advisor.md",
        callers: { haiku: "opus" },
      }),
      reviewer: role("workhorse", { brief: "roles/reviewer.md" }),
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

  it("splits a shared reviewer list, and edits it", () => {
    const original = manifest();
    const sharedWithAdvisor = {
      ...original,
      roles: { ...original.roles, reviewer: { ...original.roles.reviewer, list: "advisor" } },
    };
    const group = roleGroups(sharedWithAdvisor).find((candidate) => candidate.list === "advisor")!;
    expect(group.roles).toEqual(["reviewer", "advisor"]);
    const split = splitGroup(sharedWithAdvisor, group);
    expect(split.roles.reviewer.list).toBe("reviewer");
    expect(split.roles.advisor.list).toBe("advisor-2");
    expect(split.lists.reviewer).toEqual(original.lists.advisor);
    const edited = removeEntry(split, "reviewer", "sol");
    const saved = decodeManifest(encodeManifest(edited));
    expect(saved).toEqual(edited);
    expect(saved.lists.workhorse).toEqual(original.lists.workhorse);
    expect(saved.lists.reviewer).toEqual([{ model: "opus", effort: "high" }]);
    expect(isValid(removeEntry(saved, "reviewer", "opus"))).toBe(false);
  });

  it("shows the Reviewer as one job with one list and names other roles on a shared list", () => {
    const original = manifest();
    const jobs = jobsFor(original, roleGroups(original));
    const reviewers = jobs.filter((job) => job.roles.includes("reviewer"));
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]!.roles).toEqual(["reviewer"]);
    expect(reviewers[0]!.sections).toHaveLength(1);
    expect(reviewers[0]!.sections[0]!.list).toBe("workhorse");
    expect(reviewers[0]!.sections[0]!.title).toBeUndefined();
    expect(reviewers[0]!.sections[0]!.hint).toContain("Also used by Implementer");
    expect(reviewers[0]!.splitGroups.map((group) => group.list)).toEqual(["workhorse"]);
    expect(jobs.flatMap((job) => job.roles).toSorted()).toEqual(
      Object.keys(original.roles).toSorted(),
    );
  });

  it("splitting the Reviewer job leaves separate lists for it and for the roles it shared with", () => {
    const original = manifest();
    const job = jobsFor(original, roleGroups(original)).find((candidate) =>
      candidate.roles.includes("reviewer"),
    )!;
    const split = splitJob(original, job);
    expect(isValid(split)).toBe(true);
    expect(split.roles.reviewer.list).toBe("reviewer");
    expect(split.roles.implementer.list).toBe("implementer");
  });

  it("names only enabled providers that do not declare read-only enforcement", () => {
    expect(
      readOnlyUnenforcedProviders([
        provider({ readOnlySourceAccess: "enforced" }),
        provider({ driver: "cursor", instanceId: "cursor", displayName: "Cursor" }),
        provider({ driver: "muse", instanceId: "muse", displayName: "Muse", enabled: false }),
        provider({ driver: "grok", instanceId: "grok" }),
        provider({ driver: "cursor", instanceId: "cursor-2", displayName: "Cursor" }),
      ]),
    ).toEqual(["Cursor", "grok"]);
    expect(readOnlyUnenforcedProviders([provider({ readOnlySourceAccess: "enforced" })])).toEqual(
      [],
    );
  });

  it("shows roles that share a list as one job, in page order, and edits no retired role", () => {
    expect(roleGroups(manifest()).map((group) => group.roles)).toEqual([
      ["implementer", "reviewer"],
      ["advisor"],
      ["browser", "scout"],
    ]);
    const saved = manifest();
    const retired = {
      ...saved,
      roles: {
        ...saved.roles,
        "ui-verifier": { ...saved.roles.browser, brief: "roles/ui-verifier.md" },
        researcher: { ...saved.roles.scout!, brief: "roles/researcher.md" },
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
    expect(roleGroups(split)).toHaveLength(4);
  });

  it("edits a list several roles share once, so every role naming it follows", () => {
    const original = manifest();
    const job = jobsFor(original, roleGroups(original)).find((candidate) =>
      candidate.roles.includes("scout"),
    )!;
    expect(job.roles).toEqual(["browser", "scout"]);
    expect(job.sections.map((section) => section.list)).toEqual(["readers"]);
    // The one list the job shows is the list both roles read, so removing a model from it
    // reaches both, and leaves one shared list rather than two.
    const removed = removeEntry(original, "readers", "haiku");
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

  it("swapping a listed model keeps its place, the exceptions that named it", () => {
    const [model] = catalogModels([provider()]);
    const fable = { ...model!, binding: { ...model!.binding, model: "claude-fable" } };
    const original = manifest();
    const next = replaceEntry(original, "advisor", "opus", fable, "medium");
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

  it("joins a pooled model and its listed accounts into one row with one shared note", () => {
    const claude = provider({
      driver: "claudeAgent",
      instanceId: "claude",
      models: [
        {
          slug: "claude-opus",
          name: "Opus 5.5",
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
    });
    const pi = provider({
      driver: "pi",
      instanceId: "pi",
      models: [
        {
          slug: "antigravity/claude-opus",
          name: "Opus 5.5 (Antigravity)",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "thinking",
                label: "Thinking",
                type: "select",
                options: [{ id: "medium", label: "Medium" }],
              },
            ],
          },
        },
      ],
    });
    const order = [AccountId.make("pi:antigravity"), AccountId.make("claude")];
    const pooledModelKeys = multiAccountModels([claude, pi], {}).map((model) => model.key);
    const routing = {
      pooledModelKeys,
      modelAccounts: Object.fromEntries(pooledModelKeys.map((key) => [key, order])),
    };
    const pools = pooledModels([claude, pi], routing);
    const pool = pools[0]!;

    // When the model's first account is taken off it, the catalog binding uses the first
    // account still on it, with anyAccount: true.
    const removedRouting = {
      pooledModelKeys,
      modelAccounts: { [pool.key]: [AccountId.make("claude")] },
    };
    const catalog = catalogModels([claude, pi], removedRouting);
    const pooledEntry = catalog.find((candidate) => candidate.pooledKey === pool.key)!;
    expect(pooledEntry.binding).toMatchObject({
      driverKind: "claudeAgent",
      model: "claude-opus",
      anyAccount: true,
    });
    expect(
      catalog.find(
        (candidate) =>
          candidate.pooledKey === undefined &&
          candidate.binding.model === "antigravity/claude-opus",
      )?.binding.anyAccount,
    ).toBeUndefined();

    // Both anyAccount and legacy poolId bindings display as the pooled model's displayName.
    expect(modelLabel(pooledEntry.binding, "any", [claude, pi], pools)).toBe(pool.displayName);
    expect(
      modelLabel(
        {
          driverKind: ProviderDriverKind.make("claudeAgent"),
          model: "claude-opus",
          poolId: "legacy",
        },
        "legacy",
        [claude, pi],
        pools,
      ),
    ).toBe(pool.displayName);
    expect(isAnyAccountBinding({ poolId: "legacy" })).toBe(true);
    expect(matchesCatalogModel(pooledEntry.binding, pooledEntry, pools)).toBe(true);
    expect(matchesCatalogModel(manifest().models.opus!, pooledEntry, pools)).toBe(false);

    const base = manifest();
    const notedSlot = setModelNote(base, "claude-opus", "Strongest; design work");
    const withPiSlot = addEntry(
      {
        ...notedSlot,
        models: {
          ...notedSlot.models,
          "pi-opus": {
            driverKind: ProviderDriverKind.make("pi"),
            model: "antigravity/claude-opus",
          },
        },
      },
      "workhorse",
      { model: "pi-opus" },
    );
    const [withPooled, pooledAlias] = listModel(
      withPiSlot,
      "readers",
      pooledEntry,
      "medium",
      pools,
    );
    // Forming the anyAccount entry carries the account's note forward.
    expect(withPooled.models[pooledAlias]!.note).toBe("Strongest; design work");
    expect(isValid(withPooled)).toBe(true);

    const rows = listedModels(withPooled, jobsFor(withPooled, roleGroups(withPooled)), pools);
    const pooledRows = rows.filter((row) => row.pooledModel?.key === pool.key);
    expect(pooledRows).toHaveLength(1);
    expect(pooledRows[0]!.alias).toBe(pooledAlias);
    expect(pooledRows[0]!.roles).toEqual(
      expect.arrayContaining(["implementer", "advisor", "browser", "scout"]),
    );
    expect(
      rows.some((row) => row.model === "claude-opus" || row.model === "antigravity/claude-opus"),
    ).toBe(false);

    const renoted = setModelNote(withPooled, `pooled:${pool.key}`, "Use for hard design", pools);
    expect(pooledNote(renoted, pool.key, pools)).toBe("Use for hard design");
    for (const alias of [pooledAlias, "opus", "pi-opus"])
      expect(renoted.models[alias]!.note).toBe("Use for hard design");
    expect(renoted.models.haiku!.note).toBeUndefined();

    const pooledStanced = setModelDefaultStance(renoted, `pooled:${pool.key}`, "implement", pools);
    expect(pooledDefaultStance(pooledStanced, pool.key, pools)).toBe("implement");
    for (const alias of [pooledAlias, "opus", "pi-opus"])
      expect(pooledStanced.models[alias]!.defaultStance).toBe("implement");
    expect(pooledStanced.models.haiku!.defaultStance).toBeUndefined();
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

  it("picks a policy model on the account that lists it, even when the composer hides it", () => {
    const luna = { slug: "openai-codex/gpt-6-luna", name: "GPT-6 Luna" };
    const flash = { slug: "opencode-go/deepseek-v4.1-flash", name: "DeepSeek 4.1 Flash" };
    const pi = (instanceId: string, isDefault: boolean, models: Array<typeof luna>) => ({
      instanceId: ProviderInstanceId.make(instanceId),
      driverKind: "pi",
      isDefault,
      models,
    });
    const entries = [pi("pi", true, [flash]), pi("pi_codex", false, [flash, luna])];
    const binding = { driverKind: ProviderDriverKind.make("pi"), model: luna.slug };
    const entry = bindingInstance(entries, binding);
    expect(entry?.instanceId).toBe("pi_codex");
    expect(bindingInstance(entries, { ...binding, model: "missing" })?.instanceId).toBe("pi");

    // The user hid Luna from the composer, so its options start with Flash.
    const options = new Map([[entry!.instanceId, [flash]]]);
    expect(withBoundModel(options, entry, luna.slug).get(entry!.instanceId)).toEqual([flash, luna]);
    expect(withBoundModel(options, entry, flash.slug)).toBe(options);
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
    // An anyAccount binding checks across all pooled accounts, including other drivers.
    const piReady = provider({
      driver: "pi",
      instanceId: "pi",
      models: [
        { slug: "antigravity/claude-opus", name: "Opus", isCustom: false, capabilities: null },
      ],
    });
    expect(
      unavailableReason({ ...opus!, anyAccount: true }, [limited, piReady], {
        now: Date.parse("2026-10-15T01:00:00Z"),
        routing: { pooledModelKeys: ["claude-opus"] },
      }),
    ).toBeNull();
    expect(
      unavailableReason({ ...opus!, anyAccount: true }, [limited, piReady], {
        now: Date.parse("2026-10-15T01:00:00Z"),
        routing: {
          pooledModelKeys: ["claude-opus"],
          modelAccounts: { "claude-opus": [AccountId.make("claude")] },
        },
      }),
    ).toBe("rate limited");
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

  describe("reviewer wrap-up", () => {
    it("round-trips the reviewer wrap-up tool call limit, defaulting to 60 when absent", () => {
      const base = manifest();
      expect(reviewerWrapUpToolCalls(base)).toBe(60);
      expect("wrapUpAfterToolCalls" in base.roles.reviewer).toBe(false);

      const raised = setReviewerWrapUpToolCalls(base, 90);
      expect(raised.roles.reviewer.wrapUpAfterToolCalls).toBe(90);
      expect(reviewerWrapUpToolCalls(raised)).toBe(90);
      const roundTripped = decodeManifest(encodeManifest(raised));
      expect(roundTripped.roles.reviewer.wrapUpAfterToolCalls).toBe(90);

      // Invalid values are ignored rather than corrupting or clearing the setting.
      expect(setReviewerWrapUpToolCalls(raised, 0)).toEqual(raised);
      expect(setReviewerWrapUpToolCalls(raised, 12.5)).toEqual(raised);

      const reset = setReviewerWrapUpToolCalls(raised, 60);
      expect("wrapUpAfterToolCalls" in reset.roles.reviewer).toBe(false);
      expect(reviewerWrapUpToolCalls(reset)).toBe(60);
      expect(encodeManifest(reset)).toEqual(encodeManifest(base));
    });
  });
});
