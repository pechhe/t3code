import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

import * as ChampionModels from "./ChampionModels.ts";

const NOW = Date.parse("2026-11-20T09:00:00.000Z");
const MODEL = "claude-opus-5-5";
const RESET = "2026-11-24T08:53:00.000Z";

const account = (id: string, usedPercent?: number, resetsAt?: string): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: id,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-20T09:00:00.000Z",
    models: [{ slug: MODEL, name: "Opus", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...(usedPercent === undefined
      ? {}
      : { usageLimits: { windows: [{ id: "w", label: "w", usedPercent, resetsAt }] } }),
  }) as unknown as ServerProvider;
const on = (id: string, pinned?: boolean): ModelSelection => ({
  instanceId: ProviderInstanceId.make(id),
  model: MODEL,
  ...(pinned ? { pinned: true } : {}),
});
const source = (
  providers: ReadonlyArray<ServerProvider>,
  accountSkips: Record<string, Record<string, { until: string; reportedReset: boolean }>> = {},
) => ({ providers, settings: { pooledModelKeys: [MODEL], accountSkips } as never, nowMs: NOW });

describe("a pooled model", () => {
  it("runs on the first account in its order that is not skipped for its limit", () => {
    const providers = [account("A"), account("B"), account("C")];
    const skipped = { A: { [MODEL]: { until: RESET, reportedReset: true } } };
    assert.deepEqual(ChampionModels.assess(on("A"), source(providers)), {
      status: "ready",
      selection: on("A"),
    });
    const next = ChampionModels.assess(on("A"), source(providers, skipped));
    assert.equal(next.status === "ready" && String(next.selection.instanceId), "B");
  });

  it("is limited only once every account is, and says when the first one returns", () => {
    const providers = [account("A"), account("B")];
    const skips = {
      A: { [MODEL]: { until: "2026-11-25T00:00:00.000Z", reportedReset: true } },
      B: { [MODEL]: { until: RESET, reportedReset: true } },
    };
    assert.deepEqual(ChampionModels.assess(on("A"), source(providers, skips)), {
      status: "limited",
      pooled: true,
      until: RESET,
    });
  });

  it("is missing when no account serves it", () => {
    assert.deepEqual(ChampionModels.assess(on("A"), source([])), { status: "missing" });
  });

  it("keeps a pinned account on that account even while its pool is skipped elsewhere", () => {
    const providers = [account("A"), account("B")];
    const skips = { A: { [MODEL]: { until: RESET, reportedReset: true } } };
    assert.deepEqual(ChampionModels.assess(on("B", true), source(providers, skips)), {
      status: "ready",
      selection: on("B", true),
    });
    assert.equal(ChampionModels.assess(on("A", true), source(providers, skips)).status, "limited");
  });
});

describe("a single account's model", () => {
  const lone = {
    providers: [account("solo", 100, RESET)],
    settings: { accountSkips: {} } as never,
    nowMs: NOW,
  };
  it("is limited by its provider window until the window resets", () => {
    assert.deepEqual(ChampionModels.assess(on("solo"), lone), {
      status: "limited",
      pooled: false,
      until: RESET,
    });
    assert.equal(
      ChampionModels.assess(on("solo"), { ...lone, nowMs: Date.parse(RESET) + 1 }).status,
      "ready",
    );
  });
});

describe("pickSlot", () => {
  const providers = [account("main", 100, RESET), account("backup"), account("other")];
  const slot = { main: on("main"), backup: on("backup") };

  it("uses the backup only when the main model cannot run", () => {
    const picked = ChampionModels.pickSlot(slot, {
      ...source(providers),
      settings: { accountSkips: {} } as never,
    });
    assert.equal(picked.use?.slot, "backup");
    const free = ChampionModels.pickSlot(slot, {
      ...source([account("main"), account("backup")]),
      settings: { accountSkips: {} } as never,
    });
    assert.equal(free.use?.slot, "main");
  });

  it("counts a model that just failed on its limit as limited before the provider shows it", () => {
    const fresh = [account("main"), account("backup")];
    const picked = ChampionModels.pickSlot(
      slot,
      { ...source(fresh), settings: { accountSkips: {} } as never },
      { failed: { selection: on("main"), until: RESET } },
    );
    assert.equal(picked.use?.slot, "backup");
    assert.deepEqual(picked.main, { status: "limited", pooled: false, until: RESET });
  });

  it("moves a pooled main model to its next free account when the failed one is counted as skipped", () => {
    const pool = [account("A"), account("B")];
    const picked = ChampionModels.pickSlot({ main: on("A") }, source(pool), {
      failed: { selection: on("A"), until: RESET },
    });
    assert.equal(picked.use?.slot, "main");
    assert.equal(String(picked.use?.selection.instanceId), "B");
  });

  it("limits a single account's model after its failure, with the reset time only when it was given", () => {
    const solo = {
      providers: [account("solo")],
      settings: { accountSkips: {} } as never,
      nowMs: NOW,
    };
    const unknown = ChampionModels.pickSlot({ main: on("solo") }, solo, {
      failed: { selection: on("solo"), until: null },
    });
    assert.isNull(unknown.use);
    assert.deepEqual(unknown.main, { status: "limited", pooled: false, until: null });
    const known = ChampionModels.pickSlot({ main: on("solo") }, solo, {
      failed: { selection: on("solo"), until: RESET },
    });
    assert.deepEqual(known.main, { status: "limited", pooled: false, until: RESET });
  });

  it("reads a skip whose reset was not reported as an unknown time", () => {
    const providers = [account("solo")];
    const skips = {
      solo: { [MODEL]: { until: "2026-11-21T00:00:00.000Z", reportedReset: false } },
    };
    const assessed = ChampionModels.assess(on("solo"), {
      providers,
      settings: { accountSkips: skips } as never,
      nowMs: NOW,
    });
    assert.deepEqual(assessed, { status: "limited", pooled: false, until: null });
    assert.include(
      ChampionModels.skipMessage({
        what: "check",
        slot: { main: on("solo") },
        assessed: { main: assessed, backup: null },
        providers,
      }),
      "until a time the provider did not give",
    );
  });

  it("uses nothing when neither can run", () => {
    const picked = ChampionModels.pickSlot(slot, {
      providers: [account("main", 100, RESET)],
      settings: { accountSkips: {} } as never,
      nowMs: NOW,
    });
    assert.isNull(picked.use);
    assert.equal(picked.backup?.status, "missing");
  });
});

describe("the models a Champion runs on", () => {
  const defaults = {
    checks: { model: on("a"), backup: on("b") },
    advice: { model: on("c") },
  };
  it("takes the machine default, or the Champion's own main model with the default's backup", () => {
    assert.deepEqual(ChampionModels.slotFor("checks", defaults, undefined), {
      slot: { main: on("a"), backup: on("b") },
      source: "default",
    });
    assert.deepEqual(ChampionModels.slotFor("checks", defaults, { checks: on("z") }), {
      slot: { main: on("z"), backup: on("b") },
      source: "champion",
    });
    assert.isNull(ChampionModels.slotFor("checks", {}, undefined));
  });

  it("reports each kind with where it came from", () => {
    assert.deepEqual(ChampionModels.nextModels(defaults, { advice: on("z") }), {
      checks: { model: on("a"), backup: on("b"), source: "default" },
      advice: { model: on("z"), source: "champion" },
    });
    assert.deepEqual(ChampionModels.nextModels({}, undefined), {});
  });
});

describe("what a skipped run says", () => {
  it("shows London time, GMT in winter and BST in summer", () => {
    assert.equal(ChampionModels.formatLondon(RESET), "24 Nov, 08:53 GMT");
    assert.equal(ChampionModels.formatLondon("2026-07-01T10:00:00.000Z"), "1 Jul, 11:00 BST");
  });

  const slot = { main: on("main"), backup: on("backup") };
  const assessed = (main: ChampionModels.Assessment, backup: ChampionModels.Assessment) => ({
    main,
    backup,
  });
  const providers = [account("main"), account("backup")];

  it("names both models, when each returns and when the next check starts", () => {
    assert.equal(
      ChampionModels.skipMessage({
        what: "check",
        slot,
        assessed: assessed(
          { status: "limited", pooled: false, until: RESET },
          { status: "limited", pooled: true, until: "2026-11-25T10:30:00.000Z" },
        ),
        providers,
        nextCheckAt: "2026-11-21T09:00:00.000Z",
      }),
      "Skipped this check: Opus is at its limit until 24 Nov, 08:53 GMT, and the backup Opus is at its limit on every account until 25 Nov, 10:30 GMT. Next check 21 Nov, 09:00 GMT.",
    );
  });

  it("says plainly when the provider gave no reset time, or the model is not on this machine", () => {
    assert.equal(
      ChampionModels.skipMessage({
        what: "check",
        slot,
        assessed: assessed(
          { status: "limited", pooled: false, until: null },
          { status: "missing" },
        ),
        providers,
      }),
      "Skipped this check: Opus is at its limit until a time the provider did not give, and the backup Opus is not available on this machine.",
    );
  });

  it("leaves the next-check suffix to checks and mentions no backup that was never set", () => {
    assert.equal(
      ChampionModels.skipMessage({
        what: "setup",
        slot: { main: on("main") },
        assessed: assessed({ status: "missing" }, null as never),
        providers,
        nextCheckAt: "2026-11-21T09:00:00.000Z",
      }),
      "Skipped this setup: Opus is not available on this machine.",
    );
  });
});

describe("a single account's model that a limit failure skipped", () => {
  it("is limited by the skip even though no pool exists for it", () => {
    const lone = {
      providers: [account("solo")],
      settings: {
        pooledModelKeys: [MODEL],
        accountSkips: { solo: { [MODEL]: { until: RESET, reportedReset: true } } },
      } as never,
      nowMs: NOW,
    };
    assert.deepEqual(ChampionModels.assess(on("solo"), lone), {
      status: "limited",
      pooled: false,
      until: RESET,
    });
  });
});

describe("a failed model with no pool key", () => {
  it("is limited by its own failure, since a skip cannot name it", () => {
    const generic = {
      ...account("A"),
      models: [{ slug: "default", name: "Default", isCustom: false, capabilities: null }],
    } as unknown as ServerProvider;
    const selection = { instanceId: ProviderInstanceId.make("A"), model: "default" };
    const src = { providers: [generic], settings: { accountSkips: {} } as never, nowMs: NOW };
    assert.equal(ChampionModels.pickSlot({ main: selection }, src).main.status, "ready");
    const failed = ChampionModels.pickSlot({ main: selection }, src, {
      failed: { selection, until: null },
    });
    assert.deepEqual(failed.main, { status: "limited", pooled: false, until: null });
    assert.equal(failed.use, null);
  });
});
