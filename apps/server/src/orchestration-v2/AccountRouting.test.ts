import { expect, it } from "@effect/vitest";
import type { ServerProvider, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { provider } from "../agents/agentPolicy.testkit.ts";
import * as RoutingDecisions from "../agents/RoutingDecisions.ts";
import * as AccountRouting from "./AccountRouting.ts";

const HOUR = 3_600_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const models = ["acct-a/claude-opus-5-5", "acct-b/claude-opus-5-5"];

it.effect("a turn's account choice records the alternatives with their resets", () =>
  Effect.gen(function* () {
    const store = yield* RoutingDecisions.RoutingDecisions;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const slot = (accountKey: string, usedPercent: number, resetMs: number) => ({
      accountKey,
      label: accountKey,
      usageLimits: {
        checkedAt: iso(nowMs),
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
      usageSlots: [slot("acct-a", 100, nowMs + HOUR), slot("acct-b", 40, nowMs + 2 * HOUR)],
    };
    const routing = AccountRouting.make({
      providerRegistry: Option.some({ getProviders: Effect.succeed([pi]) } as never),
      availability: Option.none(),
      decisions: Option.some(store),
      serverSettings: {
        getSettings: Effect.succeed({
          pooledModelKeys: ["claude-opus-5-5"],
          modelRouting: {
            "claude-opus-5-5": {
              primary: ["pi-test:acct-a", "pi-test:acct-b"],
              overflow: [],
              primaryOrder: "manual",
            },
          },
        }),
      } as never,
      getThreadShell: () => Effect.succeed(null),
    });
    const threadId = "thread-1" as ThreadId;
    const routed = yield* routing.routeCommand({
      type: "message.dispatch",
      threadId,
      commandId: "c1",
      modelSelection: { instanceId: "pi-test", model: models[0] },
    } as never);
    expect((routed as { modelSelection: { model: string } }).modelSelection.model).toBe(models[1]);
    const decision = yield* store.take(threadId);
    expect(decision?.kind).toBe("account-pool");
    expect(decision?.pinned).toBe(false);
    expect(decision?.chosen.account).toBe("pi-test:acct-b");
    expect(
      decision?.candidates.map(({ account, eligible, heldBackReason, resetsAt }) => ({
        account,
        eligible,
        heldBackReason,
        resetsAt,
      })),
    ).toEqual([
      {
        account: "pi-test:acct-a",
        eligible: false,
        heldBackReason: "exhausted",
        resetsAt: iso(nowMs + HOUR),
      },
      {
        account: "pi-test:acct-b",
        eligible: true,
        heldBackReason: undefined,
        resetsAt: iso(nowMs + 2 * HOUR),
      },
    ]);
  }).pipe(Effect.provide(RoutingDecisions.layer)),
);
