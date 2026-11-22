import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type AccountBlock,
  type ModelRoute,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  accountAvailability,
  accountIdOf,
  governingUsageWindows,
  listedPooledModels,
  modelRoutePatch,
  multiAccountModels,
  linkModelPatch,
  pickAccount,
  pooledFavoriteModel,
  pooledKeyIn,
  primaryInOrder,
  standaloneAvailability,
  unlinkModelPatch,
  pooledKeyOfFavorite,
  pooledModelKeyOf,
  pooledModelOfBinding,
  pooledModelOfSelection,
  pooledModels,
  routedModelIds,
  seedPooledModelKeys,
  selectionOnAccount,
  usageMeterOf,
  type PooledModel,
} from "./accountPools.ts";
import * as DateTime from "effect/DateTime";
import fixture from "./accountPools.fixture.json" with { type: "json" };

const NOW = Date.parse("2026-11-19T09:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const HOUR = 3_600_000;

const provider = (
  id: string,
  driver: string,
  models: ReadonlyArray<readonly [slug: string, name: string]>,
  extra: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(driver),
  displayName: id,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: iso(NOW),
  models: models.map(([slug, name]) => ({ slug, name, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
  ...extra,
});

/**
 * Henry's provider snapshots from the Mac's and peach-box's caches on 18 Nov 2026 (both machines
 * list the same models), with emails replaced and credentials, usage and fingerprints removed.
 */
const henrysProviders: ReadonlyArray<ServerProvider> = fixture.map((entry) =>
  provider(
    entry.instanceId,
    entry.driver,
    entry.models.map(([slug, name]) => [slug!, name!] as const),
    {
      enabled: entry.enabled,
      ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
    },
  ),
);

const routing = (pooledModelKeys: ReadonlyArray<string> = []) => ({
  pooledModelKeys,
});

const everyModelOnSeveralAccounts = multiAccountModels(henrysProviders, {}).map(
  (model) => model.key,
);

describe("pooledModels on Henry's providers", () => {
  // Henry adds every model several accounts serve, so the matching shows once each.
  const pools = pooledModels(henrysProviders, routing(everyModelOnSeveralAccounts));
  const byKey = (key: string) => pools.find((pool) => pool.key === key);
  const accountsOf = (pool: PooledModel | undefined) =>
    pool?.accounts.map((entry) => `${entry.account.id} ${entry.model}`);

  it("makes every model on several accounts one entry naming its accounts", () => {
    expect(byKey("claude-opus-5-5")?.displayName).toBe("Claude Opus 5.5");
    expect(accountsOf(byKey("claude-opus-5-5"))).toEqual([
      "claudeAgent claude-opus-5-5",
      "claudeAgent_claude_ys claude-opus-5-5",
      "pi:anthropic anthropic/claude-opus-5-5",
      "pi:openrouter openrouter/anthropic/claude-opus-5.5",
      "pi:claude-subscription-yardsmith claude-subscription-yardsmith/claude-opus-5-5",
      "pi:claude-subscription-hfpetch claude-subscription-hfpetch/claude-opus-5-5",
      "pi:anthropic-yardsmith anthropic-yardsmith/claude-opus-5-5",
      "pi:anthropic-hfpetch anthropic-hfpetch/claude-opus-5-5",
      "pi:antigravity antigravity/claude-opus-5-5",
    ]);
    expect(accountsOf(byKey("gpt-6-2-sol"))).toEqual([
      "codex gpt-6.2-sol",
      "pi:openai openai/gpt-6.2-sol",
      "pi:openai-codex openai-codex/gpt-6.2-sol",
      "pi:openrouter openrouter/openai/gpt-6.2-sol",
    ]);
    expect(accountsOf(byKey("gemini-4-hydrogen"))).toEqual([
      "pi:openrouter openrouter/google/gemini-4-hydrogen",
      "pi:antigravity antigravity/gemini-4-hydrogen",
    ]);
    expect(byKey("kimi-k3")?.displayName).toBe("Kimi K3");
    expect(accountsOf(byKey("kimi-k3"))).toEqual([
      "pi:opencode-go opencode-go/kimi-k3",
      "pi:openrouter openrouter/moonshotai/kimi-k3",
      "pi:commandcode commandcode/moonshotai/Kimi-K3",
    ]);
  });

  it("merges only the same model", () => {
    const plain = (name: string) =>
      name
        .replace(/^[^:()]+:\s+/, "")
        .replace(/\((Antigravity|Command Code|Yardsmith|[^)]*@[^)]*)\)/g, "")
        .replace(/^(Tencent) /, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
    for (const pool of pools) {
      const names = new Set(
        pool.accounts.map(
          (entry) =>
            entry.provider.models.find((model) => model.slug === entry.model)?.name ?? entry.model,
        ),
      );
      expect([pool.key, new Set([...names].map(plain)).size]).toEqual([pool.key, 1]);
    }
  });

  it("keeps every model reachable, each on at most one entry", () => {
    const pooled = new Map<string, string>();
    for (const pool of pools) {
      for (const entry of pool.accounts) {
        const id = `${entry.provider.instanceId} ${entry.model}`;
        expect(pooled.get(id)).toBeUndefined();
        pooled.set(id, pool.key);
      }
    }
    for (const candidate of henrysProviders.filter((entry) => entry.enabled)) {
      for (const model of candidate.models) {
        const key = pooledModelKeyOf(candidate, model);
        const pool = pools.find((entry) => entry.key === key);
        const sameAccount = pool?.accounts.find(
          (entry) => entry.account.id === accountIdOf(candidate, model.slug),
        );
        // Either its own entry in a pool, a second listing on an account the pool already has
        // (kept by the picker as a model of its own), or a model only one account serves.
        expect(
          pooled.has(`${candidate.instanceId} ${model.slug}`) ||
            sameAccount !== undefined ||
            pool === undefined,
        ).toBe(true);
      }
    }
  });

  it("never merges a batch, :thinking, [1m], :free, alias, dated or image variant into another model", () => {
    const traits = (slug: string, name: string) => ({
      batch: slug.includes(":batch"),
      thinking: slug.includes(":thinking"),
      oneMillion: slug.includes("[1m]"),
      free: slug.includes(":free"),
      alias: slug.includes("~") || /latest/i.test(name),
      image: /image|banana/i.test(`${slug} ${name}`),
      dates: [
        ...(name.match(/\b\d{4}(?:-\d{2}-\d{2})?\b|\b\d{8}\b/g) ?? []),
        ...(slug.match(/\d{8}|\d{4}-\d{2}-\d{2}/g) ?? []),
      ]
        .filter((token) => !/^20(2|3)\d$/.test(token))
        .sort()
        .join(","),
    });
    for (const pool of pools) {
      const distinct = new Set(
        pool.accounts.map((entry) => {
          const name = entry.provider.models.find((model) => model.slug === entry.model)!.name;
          const { dates, ...rest } = traits(entry.model, name);
          return JSON.stringify({ ...rest, dated: dates.length > 0 });
        }),
      );
      expect([pool.key, distinct.size]).toEqual([pool.key, 1]);
    }
    expect(byKey("claude-haiku-4-5@latest")).toBeDefined();
    expect(accountsOf(byKey("claude-haiku-4-5-20251001"))).toContain(
      "pi:commandcode commandcode/claude-haiku-4-5-20251001",
    );
    expect(accountsOf(byKey("claude-haiku-4-5"))).not.toContain(
      "pi:anthropic anthropic/claude-haiku-4-5",
    );
    expect(accountsOf(byKey("deepseek-v4-1-flash-1017"))).toEqual([
      "pi:opencode-go opencode-go/deepseek-v4.1-flash",
      "pi:openrouter openrouter/deepseek/deepseek-v4.1-flash-1017",
    ]);
    expect(pools.some((pool) => pool.key.startsWith("default"))).toBe(false);
    // Each entry the picker lists has a name of its own.
    const names = pools.map((pool) => pool.displayName);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("a model's route", () => {
  const models = [
    ["opus", "Opus"],
    ["sonnet", "Sonnet"],
  ] as const;
  const window = (
    id: string,
    kind: "session" | "weekly" | "monthly",
    usedPercent: number,
    resetsAt?: number,
  ) => ({
    id,
    kind,
    label: id,
    usedPercent,
    ...(resetsAt === undefined ? {} : { resetsAt: iso(resetsAt) }),
  });
  const usage = (windows: ReadonlyArray<ReturnType<typeof window>>, checkedAt = NOW) => ({
    usageLimits: { checkedAt: iso(checkedAt), windows },
  });
  const a = provider("a", "claudeAgent", models);
  const b = provider("b", "claudeAgent", models);
  const c = provider("c", "codex", models);
  const settingsWith = (route?: Partial<ModelRoute>) => ({
    pooledModelKeys: ["opus"],
    ...(route === undefined
      ? {}
      : {
          modelRouting: {
            opus: {
              primary: [],
              overflow: [],
              primaryOrder: "manual" as const,
              reserves: {},
              ...route,
            },
          },
        }),
  });
  const pool = (route?: Partial<ModelRoute>, providers = [c, b, a]) =>
    pooledModels(providers, settingsWith(route))[0]!;
  const tiers = (model: PooledModel) =>
    model.accounts.map((entry) => `${entry.account.id} ${entry.tier}`);
  const context = (blocks: ReadonlyArray<AccountBlock> = [], nowMs = NOW) => ({ blocks, nowMs });
  const picked = (model: PooledModel, options?: Parameters<typeof pickAccount>[2], blocks = []) => {
    const pick = pickAccount(model, context(blocks), options);
    return pick.type === "account" ? pick.target.account.id : pick;
  };

  it("puts subscriptions in Primary until arranged, and migrates the retired order safely", () => {
    // Never arranged: every subscription, in the order the providers list them.
    expect(tiers(pool())).toEqual(["c primary", "b primary", "a primary"]);
    const metered = provider("pi", "pi", [["openrouter/opus", "Opus"]], {
      usageSlots: [
        {
          accountKey: "openrouter",
          label: "openrouter",
          usageLimits: { checkedAt: iso(NOW), windows: [] },
          metered: true,
        },
      ],
    });
    const legacy = (modelAccounts: ReadonlyArray<string>) =>
      tiers(
        pooledModels([a, b, c, metered], {
          pooledModelKeys: ["opus"],
          modelAccounts: { opus: modelAccounts },
        })[0]!,
      );
    // Listed subscriptions stay Primary in order, a listed pay-as-you-go account is Overflow, and
    // an account the old list left out is not used.
    expect(legacy(["b", "pi:openrouter", "a"])).toEqual([
      "b primary",
      "a primary",
      "pi:openrouter overflow",
      "c off",
    ]);
    // Never listed, a pay-as-you-go account never serves.
    expect(legacy(["b"])).toEqual(["b primary", "a off", "c off", "pi:openrouter off"]);
    expect(tiers(pooledModels([a, metered], { pooledModelKeys: ["opus"] })[0]!).at(-1)).toBe(
      "pi:openrouter off",
    );
    // A saved route wins over the retired order.
    expect(
      tiers(
        pooledModels([a, b, c], {
          pooledModelKeys: ["opus"],
          modelAccounts: { opus: ["a"] },
          modelRouting: {
            opus: { primary: ["c"], overflow: ["b"], primaryOrder: "manual", reserves: {} },
          },
        })[0]!,
      ),
    ).toEqual(["c primary", "b overflow", "a off"]);
  });

  it("ranks Primary by the reset of each account's longest window, with drag order breaking ties", () => {
    const resets = (
      aWindows: ReadonlyArray<ReturnType<typeof window>>,
      bWindows: ReadonlyArray<ReturnType<typeof window>>,
      cWindows: ReadonlyArray<ReturnType<typeof window>> = [],
    ) =>
      primaryInOrder(
        pool({ primary: ["a", "b", "c"], primaryOrder: "soonest" }, [
          provider("a", "claudeAgent", models, usage(aWindows)),
          provider("b", "claudeAgent", models, usage(bWindows)),
          provider("c", "codex", models, usage(cWindows)),
        ]),
        NOW,
      ).map((entry) => entry.account.id);
    // b's 5-hour session resets first, but a's weekly quota expires sooner than b's.
    expect(
      resets(
        [
          window("session", "session", 10, NOW + 4 * HOUR),
          window("week", "weekly", 10, NOW + 30 * HOUR),
        ],
        [
          window("session", "session", 10, NOW + HOUR),
          window("week", "weekly", 10, NOW + 90 * HOUR),
        ],
      ),
    ).toEqual(["a", "b", "c"]);
    expect(
      resets(
        [window("week", "weekly", 10, NOW + 90 * HOUR)],
        [window("week", "weekly", 10, NOW + 30 * HOUR)],
      ),
    ).toEqual(["b", "a", "c"]);
    // A known future reset ranks ahead of none or one already past; ties keep the user's order.
    expect(
      resets(
        [window("week", "weekly", 10, NOW - HOUR)],
        [],
        [window("month", "monthly", 10, NOW + 400 * HOUR)],
      ),
    ).toEqual(["c", "a", "b"]);
    // Manual order is strictly top to bottom, and new work takes its first available account.
    const manual = pool({ primary: ["a", "b", "c"], primaryOrder: "manual" });
    expect(primaryInOrder(manual, NOW).map((entry) => entry.account.id)).toEqual(["a", "b", "c"]);
    expect(picked(manual)).toBe("a");
  });

  it("holds an account at its reserve for one model only, spilling to the next and then Overflow", () => {
    const codex = provider(
      "codex",
      "codex",
      models,
      usage([window("week", "weekly", 91, NOW + 50 * HOUR)]),
    );
    const credits = provider(
      "credits",
      "codex",
      models,
      usage([window("budget", "monthly", 29, NOW + 300 * HOUR)]),
    );
    const routed = (reserve: number | undefined) =>
      pooledModels([codex, credits], {
        pooledModelKeys: ["opus", "sonnet"],
        modelRouting: {
          opus: {
            primary: ["codex"],
            overflow: ["credits"],
            primaryOrder: "soonest",
            reserves: reserve === undefined ? {} : { codex: reserve },
          },
          sonnet: {
            primary: ["codex"],
            overflow: ["credits"],
            primaryOrder: "soonest",
            reserves: {},
          },
        },
      });
    const [opus, sonnet] = routed(10);
    // 9% left is at or below a 10% reserve: Opus spills to the credits, Sonnet keeps the account.
    expect(accountAvailability("opus", opus!.accounts[0]!, context())).toEqual({
      state: "reserved",
      remainingPercent: 9,
      returnsAt: iso(NOW + 50 * HOUR),
    });
    expect(picked(opus!)).toBe("credits");
    expect(pickAccount(opus!, context())).toMatchObject({
      type: "account",
      target: { tier: "overflow" },
    });
    expect(picked(sonnet!)).toBe("codex");
    // Without a reserve, the account serves to its last percent.
    expect(picked(routed(undefined)[0]!)).toBe("codex");
    // Every account held back: unavailable, naming the earliest return.
    const spent = pooledModels(
      [
        codex,
        provider(
          "credits",
          "codex",
          models,
          usage([window("budget", "monthly", 100, NOW + 300 * HOUR)]),
        ),
      ],
      settingsWith({ primary: ["codex"], overflow: ["credits"], reserves: { codex: 10 } }),
    )[0]!;
    expect(pickAccount(spent, context())).toEqual({
      type: "unavailable",
      returnsAt: iso(NOW + 50 * HOUR),
    });
  });

  it("keeps a thread on its account while it is available, even on Overflow, and moves it when not", () => {
    const route = { primary: ["a", "b"], overflow: ["c"] };
    expect(picked(pool(route), { current: "c" })).toBe("c");
    expect(picked(pool(route), { current: "b" })).toBe("b");
    expect(picked(pool(route), { current: "x" })).toBe("a");
    const atReserve = pool({ ...route, reserves: { c: 20 } }, [
      a,
      b,
      provider("c", "codex", models, usage([window("week", "weekly", 85, NOW + HOUR)])),
    ]);
    expect(picked(atReserve, { current: "c" })).toBe("a");
    // A failover leaves the failed account out.
    expect(picked(pool(route), { exclude: "a" })).toBe("b");
    // An account used for no tier never serves, even as the thread's own.
    expect(picked(pool({ primary: ["a"] }), { current: "c" })).toBe("a");
  });

  it("backs an account off after failures, until a newer reading shows room above its reserve", () => {
    const block = (overrides: Partial<AccountBlock> = {}): AccountBlock => ({
      account: "a",
      model: "opus",
      reason: "rate-limit",
      since: iso(NOW - 60_000),
      until: iso(NOW + 9 * 60_000),
      reportedReset: false,
      attempts: 2,
      ...overrides,
    });
    const reading = (checkedAt: number, usedPercent: number, extra: object = {}) =>
      provider("a", "claudeAgent", models, {
        usageLimits: {
          checkedAt: iso(checkedAt),
          windows: [window("week", "weekly", usedPercent, NOW + 50 * HOUR)],
          ...extra,
        },
      });
    const state = (account: ServerProvider, blocks: ReadonlyArray<AccountBlock>, reserve = 10) =>
      accountAvailability(
        "opus",
        pool({ primary: ["a", "b"], reserves: { a: reserve } }, [account, b]).accounts[0]!,
        context(blocks),
      ).state;
    expect(state(a, [block()])).toBe("cooldown");
    expect(picked(pool({ primary: ["a", "b"] }), undefined, [block()] as never)).toBe("b");
    // A strictly newer reading with more than 5% above the 10% reserve clears it.
    expect(state(reading(NOW, 50), [block()])).toBe("available");
    // Only 4% above the reserve, an older reading, or a failed probe leaves it in force.
    expect(state(reading(NOW, 86), [block()])).toBe("cooldown");
    expect(state(reading(NOW - 2 * 60_000, 50), [block()])).toBe("cooldown");
    expect(state(reading(NOW, 50, { unavailable: { reason: "probeFailed" } }), [block()])).toBe(
      "cooldown",
    );
    // A partial reading missing a window that governed when the block began leaves it in force.
    expect(state(reading(NOW, 50), [block({ windowIds: ["week", "session"] })])).toBe("cooldown");
    expect(state(reading(NOW, 50), [block({ windowIds: ["week"] })])).toBe("available");
    // A block for another model, or one that has ended, holds nothing.
    expect(state(a, [block({ model: "sonnet" })])).toBe("available");
    expect(state(a, [block({ until: iso(NOW) })])).toBe("available");
    // An account comes back when its last blocker ends; a model when its first account does.
    const both = accountAvailability(
      "opus",
      pool({ primary: ["a"] }, [reading(NOW - 2 * 60_000, 100), b]).accounts[0]!,
      context([block()]),
    );
    expect([both.state, both.returnsAt]).toEqual(["exhausted", iso(NOW + 50 * HOUR)]);
    expect(
      pickAccount(
        pool({ primary: ["a", "b"] }),
        context([block(), block({ account: "b", until: iso(NOW + HOUR) })]),
      ),
    ).toMatchObject({ type: "unavailable", returnsAt: iso(NOW + 9 * 60_000) });
  });

  it("reads each Antigravity login's quotas by its family, so a spent Claude quota never holds Gemini", () => {
    const login = provider(
      "pi",
      "pi",
      [
        ["antigravity-petch777/gemini-4-hydrogen", "Gemini 4 Hydrogen"],
        ["antigravity-petch777/claude-opus-5-5", "Claude Opus 5.5"],
      ],
      {
        usageSlots: [
          {
            accountKey: "antigravity-petch777",
            label: "antigravity-petch777",
            providerFamily: "antigravity",
            usageLimits: {
              checkedAt: iso(NOW),
              windows: [
                window("3p-weekly", "weekly", 100, NOW + HOUR),
                window("gemini-weekly", "weekly", 40, NOW + 2 * HOUR),
              ],
            },
          },
        ],
      },
    );
    expect(usageMeterOf(login, "antigravity-petch777/gemini-4-hydrogen")).toBe("antigravity");
    expect(
      governingUsageWindows(login, "antigravity-petch777/gemini-4-hydrogen").map(
        (entry) => entry.id,
      ),
    ).toEqual(["gemini-weekly"]);
    expect(
      standaloneAvailability({}, login, "antigravity-petch777/gemini-4-hydrogen", context()).state,
    ).toBe("available");
    expect(
      standaloneAvailability({}, login, "antigravity-petch777/claude-opus-5-5", context()).state,
    ).toBe("exhausted");
    // A provider that cannot say which credential serves a model has no meter for it.
    const unscoped = { ...login, conservationScope: { providerIds: [] } };
    expect(governingUsageWindows(unscoped, "antigravity-petch777/claude-opus-5-5")).toEqual([]);
  });
});

describe("the models the user adds", () => {
  const a = provider("a", "claudeAgent", [
    ["opus", "Opus"],
    ["sonnet", "Sonnet"],
  ]);
  const b = provider("b", "claudeAgent", [
    ["opus", "Opus"],
    ["sonnet", "Sonnet"],
  ]);

  it("pools only listed models, finds multi-account candidates, and lists every configured key", () => {
    const withSingle = [
      a,
      provider("b", "claudeAgent", [
        ["opus", "Opus"],
        ["sonnet", "Sonnet"],
        ["haiku", "Haiku"],
      ]),
    ];
    expect(pooledModels([a, b], routing(["opus"])).map((model) => model.key)).toEqual(["opus"]);
    expect(pooledModels([a, b], routing())).toEqual([]);
    expect(multiAccountModels([a, b], {}).map((model) => model.key)).toEqual(["opus", "sonnet"]);

    const listed = listedPooledModels(withSingle, {
      pooledModelKeys: ["opus", "haiku", "retired"],
      modelAccounts: { haiku: [] },
    });
    expect(listed.map((model) => [model.key, model.displayName, model.accounts.length])).toEqual([
      ["opus", "Opus", 2],
      ["haiku", "Haiku", 1],
      ["retired", "retired", 0],
    ]);
    expect(listed[1]?.accounts[0]?.tier).toBe("off");
    // A listed model one account serves is still routed, so its route and reserves hold.
    expect(
      pooledModels(withSingle, routing(["opus", "haiku", "retired"])).map((model) => model.key),
    ).toEqual(["opus", "haiku"]);
  });

  it("serves a model with the accounts of one the user links to it, until unlinked", () => {
    const commandCode = provider("cc", "codex", [["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"]]);
    const go = provider("go", "codex", [["deepseek-v4.1-flash", "DeepSeek V4.1 Flash 1017"]]);
    const linked = {
      ...routing(["deepseek-v4-1-flash"]),
      modelLinks: { "deepseek-v4-1-flash-1017": "deepseek-v4-1-flash" },
    };
    expect(
      pooledModels([commandCode, go], routing(["deepseek-v4-1-flash"])).map((model) =>
        model.accounts.map((entry) => entry.account.id),
      ),
    ).toEqual([["cc"]]);
    const [pool] = pooledModels([commandCode, go], linked);
    expect([pool?.displayName, pool?.accounts.map((entry) => entry.account.id)]).toEqual([
      "DeepSeek V4.1 Flash",
      ["cc", "go"],
    ]);
    // Skips and routing key the linked account's model as the model it counts as.
    expect(pooledKeyIn(linked, go, go.models[0]!)).toBe("deepseek-v4-1-flash");
    expect(pooledKeyIn({}, go, go.models[0]!)).toBe("deepseek-v4-1-flash-1017");
    // A policy binding naming a routed model's key, or one linked into it, finds it with no
    // account serving that slug; a key a slug cannot round-trip to is matched as written.
    const pools = pooledModels([commandCode, go], linked);
    const bindingOn = (model: string) =>
      pooledModelOfBinding(pools, linked, { driverKind: ProviderDriverKind.make("pi"), model })
        ?.key;
    expect(bindingOn("deepseek-v4-1-flash")).toBe("deepseek-v4-1-flash");
    expect(bindingOn("deepseek-v4-1-flash-1017")).toBe("deepseek-v4-1-flash");
    // A selection on an account since removed, instance and all, finds its model by what
    // routing saw that account serve; with nothing seen it is not guessed.
    const onGo = { instanceId: ProviderInstanceId.make("go"), model: "deepseek-v4.1-flash" };
    const afterGo = pooledModels([commandCode], linked);
    const seenGo = new Map(routedModelIds(pools));
    expect(pooledModelOfSelection(afterGo, [commandCode], linked, onGo, seenGo)?.key).toBe(
      "deepseek-v4-1-flash",
    );
    expect(pooledModelOfSelection(afterGo, [commandCode], linked, onGo)).toBeUndefined();
    // Unlinked after the account went, it is the model it was, not the one it counted as.
    const goToo = provider("go2", "codex", [["deepseek-v4.1-flash", "DeepSeek V4.1 Flash 1017"]]);
    const seenLinked = new Map(routedModelIds(pooledModels([commandCode, go, goToo], linked)));
    const unlinked = routing(["deepseek-v4-1-flash", "deepseek-v4-1-flash-1017"]);
    const afterUnlink = pooledModels([commandCode, goToo], unlinked);
    expect(
      pooledModelOfSelection(afterUnlink, [commandCode, goToo], {}, onGo, seenLinked)?.key,
    ).toBe("deepseek-v4-1-flash-1017");
    const latest = provider("v", "codex", [["v2@latest", "V2"]]);
    const latestKey = pooledModelKeyOf(latest, latest.models[0]!);
    const latestPools = pooledModels([latest], routing([latestKey!]));
    expect(
      pooledModelOfBinding(
        latestPools,
        {},
        { driverKind: ProviderDriverKind.make("pi"), model: latestKey! },
      )?.key,
    ).toBe(latestKey);
    // A removed account whose slug a different model shares keeps its own model, never that one.
    const old = provider("old", "codex", [["v2", "V2 (latest)"]]);
    const aliasToo = provider("a", "codex", [["~v2", "V2"]]);
    const fixed = provider("f", "codex", [["v2", "V2"]]);
    const keys = [old, fixed].map((one) => pooledModelKeyOf(one, one.models[0]!)!);
    expect(keys).toEqual(["v2@latest", "v2"]);
    const seenOld = new Map(routedModelIds(pooledModels([old, aliasToo, fixed], routing(keys))));
    const onOld = { instanceId: ProviderInstanceId.make("old"), model: "v2" };
    for (const survivors of [
      [aliasToo, fixed],
      [fixed, aliasToo],
    ]) {
      const after = pooledModels(survivors, routing(keys));
      expect(pooledModelOfSelection(after, survivors, {}, onOld, seenOld)?.key).toBe("v2@latest");
      expect(pooledModelOfSelection(after, survivors, {}, onOld)).toBeUndefined();
    }
  });

  it("links a model into an arranged one without its pay-as-you-go accounts, and unlinks back", () => {
    const commandCode = provider("cc", "codex", [["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"]]);
    const go = provider("go", "codex", [["deepseek-v4.1-flash", "DeepSeek V4.1 Flash 1017"]]);
    const paid = provider("pi", "pi", [["openrouter/deepseek/deepseek-v4.1-flash-1017", "1017"]], {
      usageSlots: [
        {
          accountKey: "openrouter",
          label: "openrouter",
          usageLimits: { checkedAt: iso(NOW), windows: [] },
          metered: true,
        },
      ],
    });
    const providers = [commandCode, go, paid];
    const before = {
      pooledModelKeys: ["deepseek-v4-1-flash", "deepseek-v4-1-flash-1017"],
      modelAccounts: { "deepseek-v4-1-flash": ["cc"] },
    };
    const [target, source] = ["deepseek-v4-1-flash", "deepseek-v4-1-flash-1017"].map((key) =>
      listedPooledModels(providers, before).find((model) => model.key === key)!,
    );
    const link = linkModelPatch(before, target!, source!);
    // The retired order becomes a route: the source's subscription joins Primary.
    expect(link).toEqual({
      modelLinks: { "deepseek-v4-1-flash-1017": "deepseek-v4-1-flash" },
      pooledModelKeys: ["deepseek-v4-1-flash"],
      modelRouting: {
        "deepseek-v4-1-flash": {
          primary: ["cc", "go"],
          overflow: [],
          primaryOrder: "soonest",
          reserves: {},
        },
      },
      modelAccounts: { "deepseek-v4-1-flash": null },
    });
    const linked = {
      pooledModelKeys: link.pooledModelKeys!,
      modelRouting: {
        "deepseek-v4-1-flash": {
          primary: ["cc", "go"],
          overflow: ["pi:openrouter"],
          primaryOrder: "manual" as const,
          reserves: { go: 10 },
        },
      },
      modelLinks: { "deepseek-v4-1-flash-1017": "deepseek-v4-1-flash" },
    };
    expect(
      unlinkModelPatch(providers, linked, "deepseek-v4-1-flash", "deepseek-v4-1-flash-1017"),
    ).toEqual({
      modelLinks: { "deepseek-v4-1-flash-1017": null },
      pooledModelKeys: ["deepseek-v4-1-flash", "deepseek-v4-1-flash-1017"],
      modelRouting: {
        "deepseek-v4-1-flash": {
          primary: ["cc"],
          overflow: [],
          primaryOrder: "manual",
          reserves: {},
        },
      },
    });
  });

  it("leaves out an account the model is hidden on", () => {
    const c = provider("c", "claudeAgent", [["sonnet", "Sonnet"]]);
    const hiddenOnA = {
      ...routing(["sonnet"]),
      providerModelPreferences: { a: { hiddenModels: ["sonnet"], modelOrder: [] } },
    };
    expect(
      pooledModels([a, b, c], hiddenOnA).flatMap((model) =>
        model.accounts.map((entry) => entry.account.id),
      ),
    ).toEqual(["b", "c"]);
    expect(
      pooledModels([a, b], hiddenOnA).map((model) =>
        model.accounts.map((entry) => entry.account.id),
      ),
    ).toEqual([["b"]]);
  });

  it("leaves a pay-as-you-go account off a model until the user lists it there", () => {
    const pi = provider(
      "pi",
      "pi",
      [
        ["openrouter/anthropic/sonnet", "Sonnet"],
        ["claude-subscription-hfpetch/sonnet", "Sonnet"],
      ],
      {
        usageSlots: [
          {
            accountKey: "openrouter",
            label: "openrouter",
            usageLimits: { checkedAt: iso(NOW), windows: [] },
            metered: true,
          },
        ],
      },
    );
    const accountsOf = (settings: Parameters<typeof pooledModels>[1]) =>
      pooledModels([a, pi], settings).flatMap((model) =>
        model.accounts.map((entry) => [entry.account.id, entry.tier]),
      );
    expect(accountsOf(routing(["sonnet"]))).toEqual([
      ["a", "primary"],
      ["pi:claude-subscription-hfpetch", "primary"],
      ["pi:openrouter", "off"],
    ]);
    // Listed in the retired order, it serves only as Overflow, after every subscription listed.
    expect(
      accountsOf({
        ...routing(["sonnet"]),
        modelAccounts: { sonnet: ["pi:openrouter", "a"] },
      }),
    ).toEqual([
      ["a", "primary"],
      ["pi:openrouter", "overflow"],
      ["pi:claude-subscription-hfpetch", "off"],
    ]);
  });

  it("seeds the models Henry uses: his favorites and the models his roles name", () => {
    const pi = provider("pi", "pi", [
      ["antigravity/gemini-4-hydrogen", "Gemini 4 Hydrogen (Antigravity)"],
      ["openrouter/google/gemini-4-hydrogen", "Gemini 4 Hydrogen"],
      ["openrouter/moonshotai/kimi-k3", "Kimi K3"],
      ["antigravity/claude-opus-5-5", "Claude Opus 5.5 (Antigravity)"],
    ]);
    const claude = provider("claude-yardsmith", "claudeAgent", [
      ["claude-opus-5-5", "Claude Opus 5.5"],
    ]);
    const codex = provider("codex", "codex", [["gpt-6.2-sol", "GPT-6.2 Sol"]]);
    const seeds = (input: {
      favorites: ReadonlyArray<{ provider: string; model: string }>;
      roleModels: ReadonlyArray<{ driver: string; model: string }>;
    }) =>
      seedPooledModelKeys({
        providers: [pi, claude, codex],
        favorites: input.favorites.map((favorite) => ({
          provider: ProviderInstanceId.make(favorite.provider),
          model: favorite.model,
        })),
        roleModels: input.roleModels.map((binding) => ({
          driver: ProviderDriverKind.make(binding.driver),
          model: binding.model,
        })),
      });

    expect(
      seeds({
        favorites: [
          { provider: "pi", model: "antigravity/gemini-4-hydrogen" },
          { provider: "claude-yardsmith", model: "claude-opus-5-5" },
          // Favoriting a model twice seeds it once.
          { provider: "pi", model: "antigravity/gemini-4-hydrogen" },
        ],
        roleModels: [
          { driver: "codex", model: "gpt-6.2-sol" },
          { driver: "claudeAgent", model: "claude-opus-5-5" },
        ],
      }),
      // GPT-6.2 Sol has one account, so the list could never show it: it isn't seeded.
    ).toEqual(["gemini-4-hydrogen", "claude-opus-5-5"]);
    // A model no account serves any more, such as a removed login's, seeds nothing.
    expect(
      seeds({
        favorites: [{ provider: "pi", model: "opencode-go/kimi-k3" }],
        roleModels: [{ driver: "cursor", model: "composer-3" }],
      }),
    ).toEqual([]);
  });
});

describe("selectionOnAccount", () => {
  it("carries the reasoning effort to the target account's own option and drops the rest", () => {
    const target = provider("pi", "pi", []);
    const withModel: ServerProvider = {
      ...target,
      models: [
        {
          slug: "antigravity/claude-opus-5-5",
          name: "Claude Opus 5.5 (Antigravity)",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "thinking",
                label: "Thinking",
                type: "select",
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
      ],
    };
    expect(
      selectionOnAccount(
        { provider: withModel, model: "antigravity/claude-opus-5-5" },
        [
          { id: "effort", value: "high" },
          { id: "fastMode", value: true },
        ],
        true,
      ),
    ).toEqual({
      instanceId: "pi",
      model: "antigravity/claude-opus-5-5",
      pinned: true,
      options: [{ id: "thinking", value: "high" }],
    });
  });
});

describe("a pooled model among the favorites", () => {
  it("is told apart from every model an account serves", () => {
    const saved = { provider: "pi", model: pooledFavoriteModel("claude-opus-5-5") };
    expect(pooledKeyOfFavorite(saved)).toBe("claude-opus-5-5");
    for (const slug of fixture.flatMap((entry) => entry.models.map(([slug]) => slug!))) {
      expect(pooledKeyOfFavorite({ model: slug })).toBeUndefined();
    }
  });
});

describe("editing a model's route", () => {
  it("saves the edit and keeps saved accounts the model does not show now", () => {
    const a = provider("a", "claudeAgent", [["opus", "Opus"]]);
    const b = provider("b", "claudeAgent", [["opus", "Opus"]]);
    const settings = {
      pooledModelKeys: ["opus"],
      modelAccounts: { opus: ["a", "x", "b"] },
    };
    const [model] = pooledModels([a, b], settings);
    expect(
      modelRoutePatch(settings, model!, {
        primary: ["b"],
        overflow: ["a"],
        primaryOrder: "manual",
        reserves: { a: 15 },
      }),
    ).toEqual({
      modelRouting: {
        opus: { primary: ["b"], overflow: ["a", "x"], primaryOrder: "manual", reserves: { a: 15 } },
      },
      modelAccounts: { opus: null },
    });
  });
});
