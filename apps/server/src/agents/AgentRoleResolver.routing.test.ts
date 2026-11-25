import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  RunSetupRecord,
  RunSetupRouting,
  type AgentPolicySnapshot,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Schema from "effect/Schema";
import * as Resolver from "./AgentRoleResolver.ts";
import { provider, request, snapshot } from "./agentPolicy.testkit.ts";
import * as RunSetup from "./RunSetupRecorder.ts";
import * as RoutingDecisions from "./RoutingDecisions.ts";

const decodeRouting = Schema.decodeEffect(RunSetupRouting);
const decodeRecord = Schema.decodeEffect(RunSetupRecord);

const HOUR = 3_600_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const models = ["acct-a/claude-opus-5-5", "acct-b/claude-opus-5-5"];

const routingOf = (result: { readonly routing?: RunSetupRouting }) =>
  result.routing === undefined ? Effect.die("no routing recorded") : Effect.succeed(result.routing);

const decideRouting = (
  resolver: Resolver.AgentRoleResolver["Service"],
  value: Parameters<Resolver.AgentRoleResolver["Service"]["decide"]>[0],
) => resolver.decide(value).pipe(Effect.flatMap(routingOf));

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

it.layer(Resolver.layer)("role choice routing record", (it) => {
  it.effect("records an exhausted and an available candidate, and the one chosen", () =>
    Effect.gen(function* () {
      const resolver = yield* Resolver.AgentRoleResolver;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const routing = yield* decideRouting(resolver, setup(nowMs, 100, 30));
      expect(routing.kind).toBe("role-candidates");
      expect(routing.role).toBe("implementer");
      expect(routing.pinned).toBe(false);
      expect(routing.chosen).toEqual({
        model: models[1],
        instanceId: "pi-test",
        account: "pi-test:acct-b",
      });
      expect(
        routing.candidates.map(({ model, eligible, heldBackReason }) => ({
          model,
          eligible,
          heldBackReason,
        })),
      ).toEqual([
        { model: models[1], eligible: true, heldBackReason: undefined },
        { model: models[0], eligible: false, heldBackReason: "exhausted" },
      ]);
      const [chosen, held] = routing.candidates;
      expect(chosen?.remainingPercent).toBe(70);
      expect(chosen?.resetsAt).toBe(iso(nowMs + 2 * HOUR));
      expect(held?.remainingPercent).toBe(0);
      expect(held?.resetsAt).toBe(iso(nowMs + HOUR));
      expect(held?.readingAgeSeconds).toBe(90);
      expect(yield* decodeRouting(routing)).toEqual(routing);
    }),
  );

  it.effect("ranks an eligible alternative not-preferred and marks a named account pinned", () =>
    Effect.gen(function* () {
      const resolver = yield* Resolver.AgentRoleResolver;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const open = yield* resolver.decide(setup(nowMs, 10, 30));
      expect(
        (yield* routingOf(open)).candidates.map((candidate) => candidate.heldBackReason),
      ).toEqual([undefined, "not-preferred"]);
      const named = yield* resolver.decide({
        ...setup(nowMs, 10, 30),
        selection: { instanceId: open.selection.instanceId, model: models[1]! },
      });
      expect((yield* routingOf(named)).pinned).toBe(true);
      expect((yield* routingOf(named)).modelNamed).toBe(true);
      expect((yield* routingOf(named)).chosen.model).toBe(models[1]);
    }),
  );

  it.effect("never records credentials, emails or tokens", () =>
    Effect.gen(function* () {
      const resolver = yield* Resolver.AgentRoleResolver;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const value = setup(nowMs, 100, 30);
      const withSecrets = {
        ...value,
        providers: value.providers.map((candidate) => ({
          ...candidate,
          auth: {
            status: "authenticated" as const,
            email: "henry@example.com",
            label: "tok-secret",
          },
        })),
      };
      const routing = yield* decideRouting(resolver, withSecrets);
      expect(JSON.stringify(routing)).not.toMatch(/henry@example\.com|tok-secret/u);
    }),
  );
});

it.effect(
  "a pending decision is claimed once, and a pool placement after a role merges as both",
  () =>
    Effect.gen(function* () {
      const store = yield* RoutingDecisions.RoutingDecisions;
      const base = {
        decidedAt: "2025-01-01T00:00:00.000Z",
        pinned: false,
        modelNamed: false,
        chosen: { model: "m", instanceId: "i", account: "a" },
        candidates: [],
      } as const;
      const thread = "thread-1" as never;
      yield* store.note(thread, { ...base, kind: "role-candidates", role: "implementer" });
      yield* store.note(thread, { ...base, kind: "account-pool" });
      const merged = yield* store.take(thread);
      expect(merged?.kind).toBe("both");
      expect(merged?.role).toBe("implementer");
      expect(yield* store.take(thread)).toBeUndefined();
    }).pipe(Effect.provide(RoutingDecisions.layer)),
);

it.effect("a setup record without routing still decodes", () =>
  Effect.gen(function* () {
    const old = {
      runId: "run-1",
      threadId: "thread-1",
      capturedAt: "2025-01-01T00:00:00.000Z",
      agentConfig: null,
      instructions: null,
      skills: null,
      policy: null,
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      effectiveOptions: null,
      experimentAssignments: null,
    };
    expect((yield* decodeRecord(old)).routing).toBeUndefined();
  }),
);

it.effect("the setup report carries a run's routing decision", () =>
  Effect.gen(function* () {
    const run = {
      id: "run-1",
      threadId: "thread-1",
      ordinal: 1,
      status: "completed",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      requestedAt: DateTime.makeUnsafe(0),
      startedAt: null,
    } as never;
    const routing = {
      decidedAt: "2025-01-01T00:00:00.000Z",
      kind: "account-pool",
      pinned: false,
      modelNamed: false,
      chosen: { model: "gpt-5", instanceId: "codex", account: "codex" },
      candidates: [],
    } as const;
    const base = yield* decodeRecord({
      runId: "run-1",
      threadId: "thread-1",
      capturedAt: "2025-01-01T00:00:00.000Z",
      agentConfig: null,
      instructions: null,
      skills: null,
      policy: null,
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      effectiveOptions: null,
      experimentAssignments: null,
      routing,
    });
    const [entry] = yield* RunSetup.setupReport({
      runs: [run],
      records: [base],
      turnItems: [],
      driverOf: () => "codex",
    });
    expect(entry?.routing).toEqual(routing);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

const decision = (overrides: Partial<RunSetupRouting> = {}): RunSetupRouting => ({
  decidedAt: "2025-01-01T00:00:00.000Z",
  kind: "role-candidates",
  pinned: false,
  modelNamed: false,
  chosen: { model: "m", instanceId: "i", account: "a" },
  candidates: [],
  ...overrides,
});

it("a merge over the cap keeps the later decision's chosen candidate", () => {
  const candidate = (model: string) => ({
    model,
    instanceId: "i",
    account: model,
    eligible: true,
  });
  const earlier = decision({
    candidates: Array.from({ length: 20 }, (_, index) => candidate(`old-${index}`)),
  });
  const later = decision({
    kind: "account-pool",
    chosen: { model: "new-0", instanceId: "i", account: "new-0" },
    candidates: [candidate("new-0"), candidate("new-1")],
  });
  const merged = RoutingDecisions.mergeRouting(earlier, later);
  expect(merged.kind).toBe("both");
  expect(merged.candidates).toHaveLength(20);
  expect(merged.candidates.some((entry) => entry.model === "new-0")).toBe(true);
  expect(merged.truncated).toBe(true);
});

it("decisions made far apart are not merged", () => {
  const merged = RoutingDecisions.mergeRouting(
    decision({ role: "implementer" }),
    decision({ kind: "account-pool", decidedAt: "2025-01-01T01:00:00.000Z" }),
  );
  expect(merged.kind).toBe("account-pool");
  expect(merged.role).toBeUndefined();
});

it("a run claims only a recent decision for its own model", () => {
  const run = { modelSelection: { instanceId: "i", model: "m" } };
  const started = "2025-01-01T00:00:30.000Z";
  expect(RoutingDecisions.decisionForRun(decision(), run, started)).toBeDefined();
  expect(
    RoutingDecisions.decisionForRun(
      decision(),
      { modelSelection: { instanceId: "i", model: "other" } },
      started,
    ),
  ).toBeUndefined();
  expect(
    RoutingDecisions.decisionForRun(decision(), run, "2025-01-01T00:10:00.000Z"),
  ).toBeUndefined();
  expect(
    RoutingDecisions.decisionForRun(decision(), run, "2024-12-31T23:00:00.000Z"),
  ).toBeUndefined();
});
