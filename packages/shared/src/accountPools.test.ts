import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type AccountSkips,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  accountIdOf,
  firstAccount,
  listAccounts,
  listedPooledModels,
  multiAccountModels,
  nextAccount,
  nextLocalMidnightMs,
  pooledModelKeyOf,
  pooledModels,
  seedPooledModelKeys,
  selectionOnAccount,
  skipAfterLimit,
  withSkip,
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
  accountOrder: [],
  pooledModelKeys,
  modelAccountsRemoved: {},
});

const everyModelOnSeveralAccounts = multiAccountModels(henrysProviders, routing()).map(
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
    // Pi's Antigravity logins are one account; its one model list is not split by login.
    expect(
      listAccounts(henrysProviders, []).filter((account) => account.label === "antigravity"),
    ).toHaveLength(1);
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

describe("the account order", () => {
  const a = provider("a", "claudeAgent", [["opus", "Opus"]]);
  const b = provider("b", "claudeAgent", [["opus", "Opus"]]);
  const c = provider("c", "codex", [["opus", "Opus"]]);
  const pool = (order: ReadonlyArray<string>, removed: ReadonlyArray<string> = []) =>
    pooledModels([c, b, a], {
      accountOrder: order,
      pooledModelKeys: ["opus"],
      modelAccountsRemoved: { opus: removed },
    })[0]!;

  it("tries accounts top to bottom, new accounts at the bottom, passing over removed ones", () => {
    expect(firstAccount(pool(["a", "b"]), {}, NOW)?.account.id).toBe("a");
    expect(pool(["a"]).accounts.map((entry) => entry.account.id)).toEqual(["a", "c", "b"]);
    expect(firstAccount(pool(["a", "b", "c"], ["a"]), {}, NOW)?.account.id).toBe("b");
  });

  it("skips an account until its skip ends, then tries it first again", () => {
    const skips: AccountSkips = {
      a: { opus: { until: iso(NOW + HOUR), reportedReset: true } },
    };
    const ordered = pool(["a", "b", "c"]);
    expect(firstAccount(ordered, skips, NOW)?.account.id).toBe("b");
    expect(firstAccount(ordered, skips, NOW + HOUR)?.account.id).toBe("a");
    expect(nextAccount(ordered, "b", skips, NOW)?.account.id).toBe("c");
    expect(nextAccount(ordered, "a", skips, NOW)?.account.id).toBe("b");
  });

  it("tries the account back soonest when every account is skipped, and moves nowhere", () => {
    const skips: AccountSkips = {
      a: { opus: { until: iso(NOW + 3 * HOUR), reportedReset: true } },
      b: { opus: { until: iso(NOW + HOUR), reportedReset: true } },
      c: { opus: { until: iso(NOW + 2 * HOUR), reportedReset: false } },
    };
    expect(firstAccount(pool(["a", "b", "c"]), skips, NOW)?.account.id).toBe("b");
    expect(nextAccount(pool(["a", "b", "c"]), "a", skips, NOW)).toBeUndefined();
  });

  it("skips to the failure's reset, else the reading's, else the server's midnight", () => {
    const reading = provider("a", "claudeAgent", [["opus", "Opus"]], {
      usageLimits: {
        checkedAt: iso(NOW),
        windows: [
          {
            id: "weekly",
            kind: "weekly",
            label: "Week",
            usedPercent: 100,
            resetsAt: iso(NOW + 5 * HOUR),
          },
        ],
      },
    });
    const midnightMs = nextLocalMidnightMs(NOW);
    expect(
      skipAfterLimit({
        failureResetAt: iso(NOW + HOUR),
        provider: reading,
        model: "opus",
        nowMs: NOW,
        midnightMs,
      }),
    ).toEqual({ until: iso(NOW + HOUR), reportedReset: true });
    expect(
      skipAfterLimit({
        failureResetAt: null,
        provider: reading,
        model: "opus",
        nowMs: NOW,
        midnightMs,
      }),
    ).toEqual({ until: iso(NOW + 5 * HOUR), reportedReset: true });
    expect(skipAfterLimit({ provider: a, model: "opus", nowMs: NOW, midnightMs })).toEqual({
      until: iso(midnightMs),
      reportedReset: false,
    });
    const local = DateTime.makeZonedUnsafe(midnightMs, { timeZone: DateTime.zoneMakeLocal() });
    expect(DateTime.getPart(local, "hour")).toBe(0);
    expect(midnightMs - NOW).toBeLessThanOrEqual(24 * HOUR);
  });

  it("keeps another model's skip on the account and drops lapsed ones", () => {
    const skips: AccountSkips = {
      a: {
        sonnet: { until: iso(NOW + HOUR), reportedReset: true },
        haiku: { until: iso(NOW - HOUR), reportedReset: true },
      },
    };
    expect(
      Object.keys(
        withSkip(skips, "a", "opus", { until: iso(NOW + 2 * HOUR), reportedReset: false }, NOW),
      ),
    ).toEqual(["sonnet", "opus"]);
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
    expect(multiAccountModels([a, b], routing()).map((model) => model.key)).toEqual([
      "opus",
      "sonnet",
    ]);

    const listed = listedPooledModels(withSingle, {
      accountOrder: [],
      pooledModelKeys: ["opus", "haiku", "retired"],
      modelAccountsRemoved: { haiku: ["b"] },
    });
    expect(listed.map((model) => [model.key, model.displayName, model.accounts.length])).toEqual([
      ["opus", "Opus", 2],
      ["haiku", "Haiku", 1],
      ["retired", "retired", 0],
    ]);
    expect(listed[1]?.accounts[0]?.removed).toBe(true);
    expect(
      pooledModels(withSingle, routing(["opus", "haiku", "retired"])).map((model) => model.key),
    ).toEqual(["opus"]);
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
    expect(pooledModels([a, b], hiddenOnA)).toEqual([]);
  });

  it("leaves a pay-as-you-go account off a model until the user adds it", () => {
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
        model.accounts.map((entry) => [entry.account.id, entry.removed]),
      );
    expect(accountsOf(routing(["sonnet"]))).toEqual([
      ["a", false],
      ["pi:openrouter", true],
      ["pi:claude-subscription-hfpetch", false],
    ]);
    expect(
      accountsOf({ ...routing(["sonnet"]), modelAccountsAdded: { sonnet: ["pi:openrouter"] } }),
    ).toContainEqual(["pi:openrouter", false]);
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
