import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type AgentPolicySnapshot,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type ServerProviderUsageSlot,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { snapshot } from "../agents/agentPolicy.testkit.ts";
import * as Managed from "../agents/ManagedAgentService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as AccountAvailability from "../provider/AccountAvailability.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AccountFailover from "./AccountFailover.ts";
import * as AccountRouting from "./AccountRouting.ts";
import { makeRecoverDelegatedRun } from "./DelegatedTaskRecovery.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const MODEL = "claude-opus-5-5";
const LINKED = "claude-opus-5-5-20261101";
const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = Date.parse("2026-11-19T09:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

// Two Claude subscriptions under one family on one Pi instance, the second serving a dated copy
// of the model the user counts as Opus, and Anthropic API credits as Overflow.
const HFPETCH = "pi:claude-subscription-hfpetch";
const YARDSMITH = "pi:claude-subscription-yardsmith";
const CREDITS = "pi:anthropic-yardsmith";
const slugs = {
  [HFPETCH]: "claude-subscription-hfpetch/claude-opus-5-5",
  [YARDSMITH]: "claude-subscription-yardsmith/claude-opus-5-5-20261101",
  [CREDITS]: "anthropic-yardsmith/claude-opus-5-5",
} as const;
type Account = keyof typeof slugs;
const on = (account: Account, pinned?: boolean): ModelSelection => ({
  instanceId: ProviderInstanceId.make("pi"),
  model: slugs[account],
  ...(pinned ? { pinned: true } : {}),
});

const slot = (
  accountKey: string,
  providerFamily: string,
  windows: ServerProviderUsageSlot["usageLimits"]["windows"],
  extra: Partial<ServerProviderUsageSlot> = {},
  checkedAt = NOW,
): ServerProviderUsageSlot => ({
  accountKey,
  label: accountKey,
  providerFamily,
  usageLimits: { checkedAt: iso(checkedAt), windows },
  ...extra,
});
const weekly = (usedPercent: number, resetsAt: number) => ({
  id: "weekly",
  kind: "weekly" as const,
  label: "Week",
  usedPercent,
  resetsAt: iso(resetsAt),
});
const session = (usedPercent: number, resetsAt: number) => ({
  id: "five_hour",
  kind: "session" as const,
  label: "5 hours",
  usedPercent,
  resetsAt: iso(resetsAt),
});
/**
 * The Pi instance: hfpetch's week resets in 50 hours, yardsmith's in 30 (though hfpetch's 5-hour
 * session resets first), and the credits monthly.
 */
const pi = (
  overrides: {
    readonly yardsmithChecked?: number;
    readonly yardsmithUsed?: number;
    /** An account that no longer serves the model, as when it is disabled. */
    readonly gone?: Account;
  } = {},
) =>
  ({
    instanceId: ProviderInstanceId.make("pi"),
    driver: ProviderDriverKind.make("pi"),
    displayName: "Pi",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(NOW),
    readOnlySourceAccess: "enforced",
    models: [
      { slug: slugs[HFPETCH], name: "Claude Opus 5.5" },
      { slug: slugs[YARDSMITH], name: "Claude Opus 5.5 20261101" },
      { slug: slugs[CREDITS], name: "Claude Opus 5.5" },
    ]
      .filter((model) => overrides.gone === undefined || model.slug !== slugs[overrides.gone])
      .map((model) => ({
        ...model,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinking",
              label: "Thinking",
              type: "select",
              options: [{ id: "medium", label: "medium" }],
            },
          ],
        },
      })),
    usageSlots: [
      slot("claude-subscription-hfpetch", "claude-subscription", [
        session(20, NOW + HOUR),
        weekly(30, NOW + 50 * HOUR),
      ]),
      slot(
        "claude-subscription-yardsmith",
        "claude-subscription",
        [session(20, NOW + 4 * HOUR), weekly(overrides.yardsmithUsed ?? 40, NOW + 30 * HOUR)],
        {},
        overrides.yardsmithChecked ?? NOW,
      ),
      slot(
        "anthropic-yardsmith",
        "anthropic-api",
        [
          {
            id: "budget",
            kind: "monthly" as const,
            label: "Budget",
            usedPercent: 26,
            limitUsd: 25,
            usedUsd: 6.5,
          },
        ],
        { metered: true },
      ),
    ],
    slashCommands: [],
    skills: [],
  }) as unknown as ServerProvider;

const settingsLayer = ServerSettings.layerTest({
  pooledModelKeys: [MODEL],
  modelLinks: { [LINKED]: MODEL },
  modelRouting: {
    [MODEL]: {
      primary: [HFPETCH, YARDSMITH],
      overflow: [CREDITS],
      primaryOrder: "soonest",
      reserves: {},
    },
  },
});

const usageLimit = (resetAt?: number): OrchestrationV2ProviderFailure =>
  ({
    class: "usage_limit",
    message: "You've hit your usage limit.",
    retryable: false,
    ...(resetAt === undefined ? {} : { resetAt: iso(resetAt) }),
  }) as OrchestrationV2ProviderFailure;

const run = (
  threadId: ThreadId,
  attempt: number,
  selection: ModelSelection,
  status: "failed" | "completed",
): OrchestrationV2Run =>
  ({
    id: RunId.make(`run:${threadId}:${attempt}`),
    threadId,
    ordinal: attempt,
    status,
    rootNodeId: "node:root",
    modelSelection: selection,
  }) as unknown as OrchestrationV2Run;

/** The policy's implementer list, naming Opus by one account's slug: the model alone. */
const policy: AgentPolicySnapshot = (() => {
  const original = snapshot();
  return {
    ...original,
    manifest: {
      ...original.manifest,
      models: {
        ...original.manifest.models,
        opus: {
          driverKind: ProviderDriverKind.make("pi"),
          model: slugs[HFPETCH],
          effortOption: "thinking",
        },
      },
      lists: { ...original.manifest.lists, workhorse: [{ model: "opus", effort: "medium" }] },
    },
  };
})();

/** One server: providers that can change, the failure memory, routing, failover and roles. */
const makeServer = Effect.gen(function* () {
  let providers: ReadonlyArray<ServerProvider> = [pi()];
  const registry = {
    ...makeProviderRegistryMock(),
    getProviders: Effect.sync(() => providers),
  };
  const availability = Context.get(
    yield* Layer.build(AccountAvailability.layer),
    AccountAvailability.AccountAvailability,
  );
  const settings = yield* ServerSettings.ServerSettingsService;
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const dispatched = yield* Queue.unbounded<OrchestrationV2Command>();
  const failures = new Map<string, OrchestrationV2ProviderFailure>();
  const errorItem = (runId: RunId) => ({
    type: "error",
    status: "failed",
    id: "item:error",
    ordinal: 1,
    runId,
    nodeId: "node:root",
    updatedAt: DateTime.makeUnsafe(NOW),
    failure: failures.get(runId),
  });
  /** Each thread's model selection, as its shell holds it. */
  const threads = new Map<ThreadId, ModelSelection>();
  yield* Layer.build(
    AccountFailover.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ServerSettings.ServerSettingsService, settings),
          Layer.succeed(AccountAvailability.AccountAvailability, availability),
          Layer.succeed(ProviderRegistry.ProviderRegistry, registry),
          Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.fromQueue(events) }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadRecords: (threadId: ThreadId) =>
              Effect.sync(() => {
                const latest = [...failures.keys()]
                  .filter((id) => id.startsWith(`run:${threadId}:`))
                  .at(-1);
                return {
                  thread: {},
                  runs:
                    latest === undefined
                      ? []
                      : [{ id: RunId.make(latest), ordinal: Number(latest.split(":").at(-1)) }],
                  turnItems: latest === undefined ? [] : [errorItem(RunId.make(latest))],
                };
              }) as never,
            dispatch: ((command: OrchestrationV2Command) =>
              Queue.offer(dispatched, command).pipe(Effect.as({}))) as never,
          }),
        ),
      ),
    ),
  );
  const router = AccountRouting.make({
    providerRegistry: Option.some(registry),
    availability: Option.some(availability),
    serverSettings: settings,
    getThreadShell: (threadId) =>
      Effect.sync(() => {
        const selection = threads.get(threadId);
        return selection === undefined
          ? null
          : ({
              modelSelection: selection,
              latestRunId: null,
            } as unknown as OrchestrationV2ThreadShell);
      }),
  });
  const accountOf = (selection: ModelSelection | undefined) =>
    (Object.keys(slugs) as Account[]).find((account) => slugs[account] === selection?.model);

  // The real agent_roles service, over a policy on disk, reading the same failure memory.
  const managed = Context.get(
    yield* Layer.build(
      Managed.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Sqlite.layerMemory,
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(ProcessRunner.ProcessRunner)({}),
            Layer.succeed(AccountAvailability.AccountAvailability, availability),
          ),
        ),
      ),
    ),
    Managed.ManagedAgentService,
  );
  const fs = yield* FileSystem.FileSystem;
  const policyRoot = yield* fs.makeTempDirectoryScoped({ prefix: "account-failover-policy-" });
  yield* fs.makeDirectory(`${policyRoot}/roles`, { recursive: true });
  yield* fs.writeFileString(`${policyRoot}/roles/policy.json`, JSON.stringify(policy.manifest));
  for (const role of Object.values(policy.manifest.roles))
    yield* fs.writeFileString(`${policyRoot}/${role.brief}`, "Brief\n");
  const policyEnvironment = { T3CODE_AGENT_POLICY_ROOT: policyRoot };

  // The recovery the effect worker runs for a failed delegated task.
  const recoverDelegatedRun = yield* makeRecoverDelegatedRun.pipe(
    Effect.provideService(ProviderRegistry.ProviderRegistry, registry),
    Effect.provideService(AccountAvailability.AccountAvailability, availability),
    Effect.provideService(Managed.ManagedAgentService, managed),
  );
  let delegatedTasks = 0;

  return {
    availability,
    setProviders: (next: ReadonlyArray<ServerProvider>) => {
      providers = next;
    },
    /** The account a new interactive thread starts on. */
    newThread: Effect.gen(function* () {
      const routed = yield* router.routeCommand({
        type: "thread.create",
        threadId: ThreadId.make("thread:new"),
        modelSelection: on(HFPETCH),
      } as unknown as OrchestrationV2ServerCommand);
      return routed.type === "thread.create" ? accountOf(routed.modelSelection) : undefined;
    }),
    /** A follow-up that names no model: the account it runs on, recorded on the thread. */
    followUp: (threadId: ThreadId) =>
      Effect.gen(function* () {
        const routed = yield* router.routeCommand({
          type: "message.dispatch",
          commandId: CommandId.make(`command:follow-up:${threadId}`),
          threadId,
        } as unknown as OrchestrationV2ServerCommand);
        const selection =
          routed.type === "message.dispatch"
            ? (routed.modelSelection ?? threads.get(threadId))
            : undefined;
        if (selection !== undefined) threads.set(threadId, selection);
        return accountOf(selection);
      }),
    startThread: (threadId: ThreadId, account: Account, pinned?: boolean) => {
      threads.set(threadId, on(account, pinned));
    },
    /** A run on the thread's account fails; returns where failover moved it, if anywhere. */
    fail: (threadId: ThreadId, attempt: number, failure: OrchestrationV2ProviderFailure) =>
      Effect.gen(function* () {
        const failed = run(threadId, attempt, threads.get(threadId)!, "failed");
        failures.set(failed.id, failure);
        yield* Queue.offer(events, { type: "run.updated", payload: failed } as never);
        const continuation = yield* Queue.take(dispatched);
        const next =
          continuation.type === "message.dispatch" ? continuation.modelSelection : undefined;
        if (next !== undefined) threads.set(threadId, next);
        return accountOf(next);
      }),
    /** A turn completes on the thread's account. */
    complete: (threadId: ThreadId, attempt: number) =>
      Queue.offer(events, {
        type: "run.updated",
        payload: run(threadId, attempt, threads.get(threadId)!, "completed"),
      } as never),
    /** Where a delegated task on `account` continues after this failure, or "deliver". */
    delegatedRecovery: (account: Account, failure: OrchestrationV2ProviderFailure) =>
      Effect.gen(function* () {
        delegatedTasks += 1;
        const threadId = ThreadId.make(`thread:delegated:${delegatedTasks}`);
        const failed = run(threadId, 1, on(account), "failed");
        failures.set(failed.id, failure);
        let outcome: Account | "deliver" | undefined;
        const threads = {
          getThreadRecords: () =>
            Effect.succeed({
              thread: { lineage: { parentThreadId: null }, runtimeMode: "full-access" },
              runs: [failed],
              turnItems: [errorItem(failed.id)],
            }),
          dispatch: (command: OrchestrationV2Command) =>
            Effect.sync(() => {
              outcome =
                command.type === "message.dispatch" ? accountOf(command.modelSelection) : undefined;
              return {};
            }),
          recoverDelegatedTask: () =>
            Effect.sync(() => {
              outcome = "deliver";
            }),
        } as unknown as ThreadManagement.ThreadManagementService["Service"];
        yield* recoverDelegatedRun(threads, settings, { threadId, sourceRunId: failed.id });
        return outcome;
      }),
    /** What `agent_roles` reports for the implementer: its pick, refusal and model. */
    roles: Effect.gen(function* () {
      const result = yield* managed
        .roles({
          providers,
          ceiling: "full-access",
          request: { role: "implementer", taskClass: "non-ui" },
        })
        .pipe(Effect.provideService(HostProcess.Environment, policyEnvironment));
      const [role] = result.roles;
      return {
        account: accountOf(role?.selection ?? undefined),
        refusal: role?.refusal ?? null,
        model: role?.models[0],
      };
    }),
  };
});

describe("one evaluator for interactive turns, delegated tasks and agent_roles", () => {
  it.effect(
    "agree on the account through soonest reset, failover, stickiness, backoff and recovery",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const server = yield* makeServer;
        const thread = ThreadId.make("thread:interactive");

        // Soonest reset: yardsmith's week ends first, whatever hfpetch's 5-hour session does.
        assert.strictEqual(yield* server.newThread, YARDSMITH);
        assert.strictEqual((yield* server.roles).account, YARDSMITH);
        server.startThread(thread, YARDSMITH);
        assert.strictEqual(yield* server.followUp(thread), YARDSMITH);

        // A usage limit with no reset: failover to the other subscription, which new work,
        // delegated recovery and roles all pick too; the thread then stays there.
        assert.strictEqual(yield* server.fail(thread, 1, usageLimit()), HFPETCH);
        const [backoff] = (yield* server.availability.state).blocks;
        assert.deepInclude(backoff, {
          account: YARDSMITH,
          model: MODEL,
          until: iso(NOW + 2 * MINUTE),
          reportedReset: false,
          attempts: 1,
        });
        assert.strictEqual(yield* server.newThread, HFPETCH);
        assert.strictEqual(yield* server.delegatedRecovery(YARDSMITH, usageLimit()), HFPETCH);
        assert.strictEqual((yield* server.roles).account, HFPETCH);
        assert.strictEqual(yield* server.followUp(thread), HFPETCH);

        // Both subscriptions out: Overflow takes the turn, and new work, while nothing is refused.
        assert.strictEqual(yield* server.fail(thread, 2, usageLimit(NOW + HOUR)), CREDITS);
        assert.strictEqual(yield* server.newThread, CREDITS);
        assert.strictEqual(yield* server.delegatedRecovery(HFPETCH, usageLimit()), CREDITS);
        const onOverflow = yield* server.roles;
        assert.strictEqual(onOverflow.account, CREDITS);
        // agent_roles reports the one model available, with no per-account noise.
        assert.deepInclude(onOverflow.model, { model: MODEL, available: true });
        assert.notProperty(onOverflow.model, "returnsAt");

        // yardsmith's backoff ends: new work returns to Primary, while the thread on Overflow keeps
        // its account and prompt cache.
        yield* TestClock.adjust(2 * MINUTE);
        assert.strictEqual(yield* server.newThread, YARDSMITH);
        assert.strictEqual((yield* server.roles).account, YARDSMITH);
        assert.strictEqual(yield* server.followUp(thread), CREDITS);

        // A second failure on yardsmith backs off longer: ten minutes, not until midnight.
        const second = ThreadId.make("thread:second");
        server.startThread(second, YARDSMITH);
        assert.strictEqual(yield* server.fail(second, 1, usageLimit()), CREDITS);
        assert.deepInclude(
          (yield* server.availability.state).blocks.find((block) => block.account === YARDSMITH),
          { until: iso(NOW + 12 * MINUTE), attempts: 2 },
        );

        // A newer reading with room clears yardsmith at once; a stale one would not have.
        server.setProviders([pi({ yardsmithChecked: NOW + MINUTE })]);
        assert.strictEqual(yield* server.newThread, CREDITS);
        server.setProviders([pi({ yardsmithChecked: NOW + 3 * MINUTE })]);
        assert.strictEqual(yield* server.newThread, YARDSMITH);
        assert.strictEqual((yield* server.roles).account, YARDSMITH);

        // With hfpetch out until its reset and yardsmith at its limit, a completed turn on
        // yardsmith ends its block, so its backoff starts over.
        server.setProviders([pi()]);
        server.startThread(second, YARDSMITH);
        yield* server.complete(second, 2);
        // A later failure proves the completion was handled before it.
        assert.strictEqual(yield* server.fail(second, 3, usageLimit()), CREDITS);
        assert.deepInclude(
          (yield* server.availability.state).blocks.find((block) => block.account === YARDSMITH),
          { attempts: 1, until: iso(NOW + 4 * MINUTE) },
        );

        // Every account out: roles refuse naming the earliest return, and so does a new turn.
        yield* server.availability.recordFailure({
          account: CREDITS,
          model: MODEL,
          reason: "rate-limit",
          attemptId: "run:credits",
        });
        const refused = yield* server.roles;
        assert.isUndefined(refused.account);
        assert.include(refused.refusal, "usage-limited");
        assert.include(refused.refusal, iso(NOW + 4 * MINUTE));
        assert.deepInclude(refused.model, {
          model: MODEL,
          available: false,
          returnsAt: iso(NOW + 4 * MINUTE),
        });
        // A cool-down is a guess: an interactive turn still tries the account back soonest.
        assert.strictEqual(yield* server.newThread, YARDSMITH);

        // Try now clears yardsmith for the model.
        yield* server.availability.clear({ account: YARDSMITH, model: MODEL });
        assert.strictEqual((yield* server.roles).account, YARDSMITH);
      }).pipe(Effect.provide(Layer.mergeAll(settingsLayer, NodeServices.layer))),
  );

  it.effect(
    "refuses an unpinned turn when every account is at its reserve, naming when one returns",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const server = yield* makeServer;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({
          modelRouting: {
            [MODEL]: {
              primary: [HFPETCH, YARDSMITH],
              overflow: [],
              primaryOrder: "manual",
              reserves: { [HFPETCH]: 75, [YARDSMITH]: 65 },
            },
          },
        });
        // hfpetch has 70% left of its week, under a 75% reserve; yardsmith 60%, under 65%.
        const thread = ThreadId.make("thread:reserved");
        server.startThread(thread, HFPETCH);
        const error = yield* server.followUp(thread).pipe(Effect.flip);
        assert.strictEqual(error._tag, "OrchestratorCommandRejectedError");
        assert.include(String((error as { cause?: unknown }).cause), "20 Nov, 15:00 GMT");
        assert.include((yield* server.roles).refusal, iso(NOW + 30 * HOUR));
        // Pinning an account still runs it.
        server.startThread(thread, HFPETCH, true);
        assert.strictEqual(yield* server.followUp(thread), HFPETCH);
      }).pipe(Effect.provide(Layer.mergeAll(settingsLayer, NodeServices.layer))),
  );

  it.effect("moves a follow-up off an account that stops serving the model", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const server = yield* makeServer;
      const thread = ThreadId.make("thread:disabled");
      server.startThread(thread, YARDSMITH);
      assert.strictEqual(yield* server.followUp(thread), YARDSMITH);
      server.setProviders([pi({ gone: YARDSMITH })]);
      assert.strictEqual(yield* server.followUp(thread), HFPETCH);
    }).pipe(Effect.provide(Layer.mergeAll(settingsLayer, NodeServices.layer))),
  );
});

describe("isUsageLimitFailure", () => {
  it("reads a provider's own words for running out of allowance, quota-limited included", () => {
    const words = (message: string) =>
      AccountFailover.isUsageLimitFailure({ class: "provider_error", message });
    assert.isTrue(
      words("All 1 Command Code keys are quota-limited (weekly; next reset Nov 24, 08:53)"),
    );
    assert.isTrue(words("rate limit exceeded"));
    assert.isFalse(words("connection reset by peer"));
  });
});
