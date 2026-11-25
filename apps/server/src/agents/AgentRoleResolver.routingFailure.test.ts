import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  type AgentPolicySnapshot,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Resolver from "./AgentRoleResolver.ts";
import { provider, request, snapshot } from "./agentPolicy.testkit.ts";

vi.mock("./RoutingDecisions.ts", async (importActual) => ({
  ...(await importActual<typeof import("./RoutingDecisions.ts")>()),
  routingSnapshot: () => {
    throw new Error("snapshot failed");
  },
}));

const HOUR = 3_600_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const models = ["acct-a/claude-opus-5-5", "acct-b/claude-opus-5-5"];

const setup = (nowMs: number, aUsed: number, bUsed: number) => {
  const slot = (accountKey: string, usedPercent: number, resetMs: number) => ({
    accountKey,
    label: accountKey,
    usageLimits: {
      checkedAt: iso(nowMs - 90_000),
      windows: [
        {
          id: "week",
          kind: "weekly" as const,
          label: "Week",
          usedPercent,
          resetsAt: iso(resetMs),
        },
      ],
    },
  });
  const pi: ServerProvider = {
    ...provider("pi", "pi-test", models),
    models: models.map((slug) => ({
      slug,
      name: "Claude Opus 5.5",
      isCustom: false,
      capabilities: { optionDescriptors: [] },
    })),
    usageSlots: [slot("acct-a", aUsed, nowMs + HOUR), slot("acct-b", bUsed, nowMs + 2 * HOUR)],
  };
  const original = snapshot();
  const policy: AgentPolicySnapshot = {
    ...original,
    manifest: {
      ...original.manifest,
      models: {
        ...original.manifest.models,
        opus: { driverKind: ProviderDriverKind.make("pi"), model: models[0]! },
      },
      lists: { ...original.manifest.lists, workhorse: [{ model: "opus" }] },
    },
  };
  return {
    snapshot: policy,
    providers: [pi],
    request: request({ role: "implementer" }),
    ceiling: "full-access" as const,
    routing: {
      pooledModelKeys: ["claude-opus-5-5"],
      modelRouting: {
        "claude-opus-5-5": {
          primary: ["pi-test:acct-a", "pi-test:acct-b"],
          overflow: [],
          primaryOrder: "manual" as const,
        },
      },
    },
  };
};

it.layer(Resolver.layer)("a failing routing snapshot", (it) => {
  it.effect("still returns the selection, without routing", () =>
    Effect.gen(function* () {
      const resolver = yield* Resolver.AgentRoleResolver;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const result = yield* resolver.decide(setup(nowMs, 100, 30));
      expect(result.selection.model).toBe(models[1]);
      expect(result.routing).toBeUndefined();
    }),
  );
});
