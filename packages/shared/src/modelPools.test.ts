import { describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import {
  ModelPoolId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelPoolConfig,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";

import {
  adaptModelSelectionForSlot,
  pickModelPoolFailoverSlot,
  pickModelPoolSlot,
} from "./modelPools.ts";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const at = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + hours * 3_600_000));

type Window = Pick<ServerProviderUsageWindow, "usedPercent" | "resetsAt">;
const usage = (windows: ReadonlyArray<Window>) => ({
  checkedAt: at(0),
  windows: windows.map((window, index) => ({
    id: `window-${index}`,
    kind: "session" as const,
    label: "Session",
    ...window,
  })),
});

const base = (id: string, driver: string, models: ReadonlyArray<string>): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(driver),
  displayName: id,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: at(0),
  models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
});

/** One Pi instance serving the same model through two sub-provider accounts. */
const pi = (slots: Record<string, ReadonlyArray<Window> | undefined>): ServerProvider => ({
  ...base("pi", "pi", ["hf/opus", "ys/opus"]),
  usageSlots: Object.entries(slots).flatMap(([accountKey, windows]) =>
    windows === undefined ? [] : [{ accountKey, label: accountKey, usageLimits: usage(windows) }],
  ),
});
const claude = (windows: ReadonlyArray<Window>): ServerProvider => ({
  ...base("claudeAgent", "claudeAgent", ["opus"]),
  usageLimits: usage(windows),
});

const slot = (instanceId: string, model: string, enabled?: boolean) => ({
  providerInstanceId: ProviderInstanceId.make(instanceId),
  model,
  ...(enabled === undefined ? {} : { enabled }),
});

const opus = (
  strategy: "order" | "spend",
  slots = [slot("pi", "hf/opus"), slot("pi", "ys/opus"), slot("claudeAgent", "opus")],
): ModelPoolConfig => ({ displayName: "Opus", slots, policy: { strategy } });

const pickedOf = (picked: ReturnType<typeof pickModelPoolSlot>) =>
  picked === undefined ? undefined : `${picked.slot.providerInstanceId}:${picked.slot.model}`;

describe("pickModelPoolSlot", () => {
  it("takes the first slot with allowance under My order", () => {
    const providers = [
      pi({
        hf: [{ usedPercent: 100, resetsAt: at(3) }],
        ys: [{ usedPercent: 20, resetsAt: at(9) }],
      }),
      claude([{ usedPercent: 0, resetsAt: at(1) }]),
    ];
    expect(pickedOf(pickModelPoolSlot({ pool: opus("order"), providers, nowMs: NOW }))).toBe(
      "pi:ys/opus",
    );
  });

  it("takes the soonest-lapsing allowance under Spend", () => {
    const providers = [
      pi({
        hf: [{ usedPercent: 10, resetsAt: at(48) }],
        ys: [{ usedPercent: 10, resetsAt: at(40) }],
      }),
      claude([{ usedPercent: 10, resetsAt: at(2) }]),
    ];
    expect(pickedOf(pickModelPoolSlot({ pool: opus("spend"), providers, nowMs: NOW }))).toBe(
      "claudeAgent:opus",
    );
  });

  it("never chooses a slot switched off, and counts a slot without a reading as available", () => {
    const providers = [
      pi({ ys: [{ usedPercent: 100, resetsAt: at(3) }] }),
      claude([{ usedPercent: 100, resetsAt: at(3) }]),
    ];
    const pool = opus("order", [
      slot("pi", "ys/opus"),
      slot("claudeAgent", "opus", false),
      slot("pi", "hf/opus"),
    ]);
    expect(pickedOf(pickModelPoolSlot({ pool, providers, nowMs: NOW }))).toBe("pi:hf/opus");
  });

  it("keeps a first slot with no reading first under My order", () => {
    const providers = [
      pi({ hf: [{ usedPercent: 10, resetsAt: at(3) }] }),
      { ...claude([]), usageLimits: undefined } as ServerProvider,
    ];
    const pool = opus("order", [slot("claudeAgent", "opus"), slot("pi", "hf/opus")]);
    expect(pickedOf(pickModelPoolSlot({ pool, providers, nowMs: NOW }))).toBe("claudeAgent:opus");
  });

  it("excludes a conserved slot only when conservation is enforced", () => {
    const providers = [
      pi({}),
      {
        ...claude([]),
        subagentConservation: {
          state: "active" as const,
          unavailable: false,
          models: ["opus"],
          message: "low",
        },
      } satisfies ServerProvider,
    ];
    const pool = opus("order", [slot("claudeAgent", "opus"), slot("pi", "hf/opus")]);
    expect(pickedOf(pickModelPoolSlot({ pool, providers, nowMs: NOW }))).toBe("claudeAgent:opus");
    expect(
      pickedOf(pickModelPoolSlot({ pool, providers, nowMs: NOW, enforceConservation: true })),
    ).toBe("pi:hf/opus");
  });

  it("keeps a running thread on its slot of a shared instance while it has allowance", () => {
    const providers = [
      pi({
        hf: [{ usedPercent: 10, resetsAt: at(3) }],
        ys: [{ usedPercent: 95, resetsAt: at(3) }],
      }),
    ];
    const pool = opus("order", [slot("pi", "hf/opus"), slot("pi", "ys/opus")]);
    const current = { instanceId: ProviderInstanceId.make("pi"), model: "ys/opus" };
    expect(pickedOf(pickModelPoolSlot({ pool, providers, nowMs: NOW, current }))).toBe(
      "pi:ys/opus",
    );
  });
});

describe("pickModelPoolFailoverSlot", () => {
  it("moves an exhausted slot to the next slot with allowance, across providers", () => {
    const providers = [
      pi({
        hf: [{ usedPercent: 100, resetsAt: at(3) }],
        ys: [{ usedPercent: 100, resetsAt: at(3) }],
      }),
      claude([{ usedPercent: 30, resetsAt: at(3) }]),
    ];
    const next = pickModelPoolFailoverSlot({
      pool: opus("order"),
      providers,
      nowMs: NOW,
      limited: { instanceId: ProviderInstanceId.make("pi"), model: "hf/opus" },
    });
    expect(pickedOf(next)).toBe("claudeAgent:opus");
  });

  it("finds nothing when every other slot is out, so the thread waits for the reset", () => {
    const providers = [
      pi({
        hf: [{ usedPercent: 100, resetsAt: at(3) }],
        ys: [{ usedPercent: 100, resetsAt: at(3) }],
      }),
      claude([{ usedPercent: 100, resetsAt: at(3) }]),
    ];
    const next = pickModelPoolFailoverSlot({
      pool: opus("order"),
      providers,
      nowMs: NOW,
      limited: { instanceId: ProviderInstanceId.make("pi"), model: "hf/opus" },
    });
    expect(next).toBeUndefined();
  });
});

describe("adaptModelSelectionForSlot", () => {
  it("names the pool and translates a reasoning option to the target slot's descriptor", () => {
    const target: ServerProvider = {
      ...base("claudeAgent", "claudeAgent", []),
      models: [
        {
          slug: "opus",
          name: "Opus",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "high", label: "High" },
                ],
              },
            ],
          },
        },
      ],
    };
    const selection = adaptModelSelectionForSlot({
      poolId: ModelPoolId.make("opus"),
      slot: slot("claudeAgent", "opus"),
      providers: [target],
      baseOptions: [
        { id: "thinking", value: "high" },
        { id: "piOnly", value: true },
      ],
    });
    expect(selection).toEqual({
      instanceId: "claudeAgent",
      model: "opus",
      poolId: "opus",
      options: [{ id: "effort", value: "high" }],
    });
  });
});
