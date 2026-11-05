import * as Landings from "../project/SlipJayLandings.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import { type CommandReceiptV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ChampionError,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  ProviderThreadId,
  type ChampionConfig,
  type ChampionMetricInput,
  type ChampionSampleInput,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Subagent,
  type ChampionFinding,
  type ServerProvider,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Champions from "./ChampionService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

const instanceId = ProviderInstanceId.make("test-provider");
const projectId = ProjectId.make("project:champions");
const config: ChampionConfig = {
  id: "champion:quality",
  projectId,
  name: "Quality",
  purpose: "Keep errors low",
  schedule: { type: "interval", everyMs: 60_000 },
  setupModelSelection: { instanceId, model: "strong" },
  routineModelSelection: { instanceId, model: "cheap" },
  charter: { maxConcurrentRepairs: 1, maxRepairsPerDay: 2, instructions: "Repair bounded issues." },
};
const metric: ChampionMetricInput = {
  id: "errors",
  name: "Errors",
  description: "Error count",
  unit: "count",
  source: "logs",
  context: "production",
  direction: "lower",
  minimum: null,
  maximum: 2,
};
const sample: ChampionSampleInput = {
  metricId: "errors",
  version: 1,
  unit: "count",
  status: "measured",
  value: 3,
  observedAt: "1970-01-01T00:00:00.000Z",
  source: "logs",
  evidence: "Three observed errors",
  revision: "running-revision",
};

const fixture = Effect.fn("test.championFixture")(() =>
  Effect.sync(() => {
    let owner: ThreadId | undefined;
    let messageId = "";
    let launches = 0;
    let sends = 0;
    let instanceAvailable = true;
    let failOnce = false;
    let activeRun = true;
    const launchRequests: Array<{ commandId: string; messageId: string; model: string }> = [];
    const children = new Map<ThreadId, OrchestrationV2ThreadShell>();
    const childTasks: OrchestrationV2Subagent[] = [];
    const receipts = new Map<string, CommandReceiptV2>();
    let landing: {
      status: string;
      stage: string;
      terminal: boolean;
      commitId?: string;
      finishedAt?: string;
      checks: [];
    } = { status: "running", stage: "gate", terminal: false, checks: [] };
    const sent: Array<{ commandId: string; messageId: string; text: string }> = [];
    let failSend = false;
    let landingLookup = Effect.void;
    const runId = RunId.make("run:check");
    const providerThreadId = ProviderThreadId.make("provider-thread:check");
    const caller = () => ({
      threadId: owner!,
      providerInstanceId: instanceId,
      providerSessionId: "session:check",
    });
    // These are external thread/provider boundaries; the champion ledger and SQL remain real.
    const shell = () =>
      ({
        id: owner,
        projectId,
        activeRunId: activeRun ? runId : null,
        activeProviderThreadId: providerThreadId,
        archivedAt: null,
        deletedAt: null,
      }) as OrchestrationV2ThreadShell;
    const dependencies = Layer.mergeAll(
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) =>
          Effect.gen(function* () {
            launches += 1;
            owner = input.threadId;
            messageId = input.initialMessage!.messageId!;
            launchRequests.push({
              commandId: input.commandId,
              messageId,
              model: input.modelSelection.model,
            });
            if (failOnce) {
              failOnce = false;
              return yield* new ThreadLaunch.ThreadLaunchError({
                commandId: input.commandId,
                projectId,
                operation: "dispatch-message",
                cause: "uncertain acceptance",
              });
            }
            return { threadId: owner!, projection: {} as never, resumed: launches > 1 };
          }),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(owner === id ? shell() : (children.get(id) ?? null)),
        getThreadRecords: () =>
          Effect.succeed({
            thread: shell(),
            runs: [
              {
                id: runId,
                status: "running",
                providerThreadId,
                userMessageId: messageId,
                providerInstanceId: instanceId,
                modelSelection: config.routineModelSelection,
              } as OrchestrationV2Run,
            ],
            providerThreads: [
              {
                id: providerThreadId,
                providerSessionId: "session:check",
              } as OrchestrationV2ProviderThread,
            ],
            subagents: childTasks,
          } as unknown as Effect.Success<
            ReturnType<ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"]>
          >),
        getReceipt: (id) => Effect.succeed(Option.fromUndefinedOr(receipts.get(id))),
        dispatch: () => Effect.succeed({ sequence: 1 } as never),
        sendToThread: (input) =>
          Effect.suspend(() =>
            failSend
              ? Effect.fail(
                  new ThreadManagement.ThreadManagementThreadArchivedError({
                    threadId: input.threadId,
                  }),
                )
              : Effect.sync(() => {
                  sends += 1;
                  sent.push({
                    commandId: input.commandId,
                    messageId: input.messageId,
                    text: input.text,
                  });
                  activeRun = true;
                  messageId = input.messageId;
                  return {} as never;
                }),
          ),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.suspend(() =>
          Effect.succeed(
            instanceAvailable
              ? [
                  {
                    instanceId,
                    models: [{ slug: "cheap" }, { slug: "strong" }],
                  } as unknown as ServerProvider,
                ]
              : [],
          ),
        ),
      }),
      Layer.mock(Projects.ProjectService)({
        getById: () =>
          Effect.succeedSome({ id: projectId, workspaceRoot: "/project/root" } as Project),
      }),
      Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
      Layer.mock(Landings.SlipJayLandings)({
        repositoryOf: () => Effect.succeed("test/repo"),
        readDetail: () => landingLookup.pipe(Effect.andThen(Effect.sync(() => landing))),
      }),
      NodeCrypto.layer,
    );
    return {
      layer: Champions.layer.pipe(Layer.provide(dependencies)),
      caller,
      counts: () => ({ launches, sends }),
      launchRequests,
      endRun: () => {
        activeRun = false;
      },
      failNextLaunch: () => {
        failOnce = true;
      },
      wake: () => {
        messageId = "child-result-wakeup";
      },
      sent,
      failDecisionSend: (value: boolean) => {
        failSend = value;
      },
      setReceipt: (id: string, status: "accepted" | "rejected") => {
        receipts.set(id, { status } as CommandReceiptV2);
      },
      blockLanding: (effect: Effect.Effect<void>) => {
        landingLookup = effect;
      },
      setLanding: (commitId: string, finishedAt: string) => {
        landing = {
          status: "landed",
          stage: "published",
          terminal: true,
          commitId,
          finishedAt,
          checks: [],
        };
      },
      installChild: (
        finding: ChampionFinding,
        revision: string,
        role = "implementation-worker",
        status = "completed",
        workItem?: OrchestrationV2ThreadShell["workItem"],
      ) => {
        const childThreadId = ThreadId.make(`accepted:${role}`);
        children.set(childThreadId, {
          id: childThreadId,
          projectId,
          workItem,
          agentTask: { workId: finding.workId, attemptId: finding.attemptId, role },
        } as OrchestrationV2ThreadShell);
        const index = childTasks.findIndex((t) => t.childThreadId === childThreadId);
        const task = {
          childThreadId,
          origin: "app_owned",
          status,
          result: `Handed back revision ${revision}`,
        } as OrchestrationV2Subagent;
        if (index < 0) childTasks.push(task);
        else childTasks[index] = task;
      },
      available: (value: boolean) => {
        instanceAvailable = value;
      },
    };
  }),
);
const withFixture = (
  body: (
    f: Effect.Success<ReturnType<typeof fixture>>,
    service: Champions.ChampionService["Service"],
  ) => Effect.Effect<void, ChampionError, SqlClient.SqlClient | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.gen(function* () {
      yield* body(f, yield* Champions.ChampionService);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(Sqlite.layerMemory));
const definitions = Effect.fn("test.championDefinitions")(function* (
  service: Champions.ChampionService["Service"],
) {
  yield* service.upsert(config);
  yield* service.propose({ id: config.id, metrics: [metric], reason: "Measure errors" });
  return yield* service.accept({ id: config.id });
});
const isChampionError = Schema.is(ChampionError);
const refused = <A>(effect: Effect.Effect<A, ChampionError>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => {
        assert.isTrue(isChampionError(error));
      },
      onSuccess: () => {
        assert.fail("Expected the champion operation to refuse.");
      },
    }),
  );

it.effect(
  "preserves a metric series for wording/target changes and starts a new series for source/unit/context/direction changes",
  () =>
    withFixture((_f, service) =>
      Effect.gen(function* () {
        const first = yield* definitions(service);
        yield* service.propose({
          id: config.id,
          metrics: [{ ...metric, name: "Observed errors", maximum: 1 }],
          reason: "Tighter target",
        });
        const wording = yield* service.accept({ id: config.id });
        assert.equal(wording.metrics[0]!.seriesId, first.metrics[0]!.seriesId);
        assert.equal(wording.metrics[0]!.version, 2);
        yield* service.propose({
          id: config.id,
          metrics: [{ ...metric, unit: "percent" }],
          reason: "Use error rate",
        });
        const unit = yield* service.accept({ id: config.id });
        assert.notEqual(unit.metrics[0]!.seriesId, wording.metrics[0]!.seriesId);
        yield* service.propose({
          id: config.id,
          metrics: [{ ...metric, source: "synthetic" }],
          reason: "Change measurement source",
        });
        const source = yield* service.accept({ id: config.id });
        assert.notEqual(source.metrics[0]!.seriesId, first.metrics[0]!.seriesId);
      }),
    ),
);

it.effect(
  "binds reports to authenticated live caller/run/message, freezes definitions, dedupes replays and reconciles qualitative paraphrases",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        yield* service.runCheck({ id: config.id });
        yield* refused(
          service.report(undefined, { samples: [sample], findings: [], summary: "spoof" }),
        );
        yield* refused(
          service.report(
            { ...f.caller(), providerSessionId: "other" },
            { samples: [sample], findings: [], summary: "spoof" },
          ),
        );
        yield* service.propose({
          id: config.id,
          metrics: [{ ...metric, unit: "percent" }],
          reason: "Change later checks",
        });
        yield* service.accept({ id: config.id });
        assert.equal((yield* service.checkContext(f.caller())).metrics[0]!.unit, "count");
        const input = {
          samples: [sample],
          findings: [{ title: "Slow database queries", evidence: "Observed query backlog" }],
          summary: "Error budget breached",
        };
        const reported = yield* service.report(f.caller(), input);
        yield* service.report(f.caller(), input);
        assert.equal(reported.findings.length, 2);
        const history = yield* service.history({ id: config.id });
        assert.equal(history.samples.length, 1);
        assert.equal(history.samples[0]!.threadId, f.caller().threadId);
        assert.equal(history.samples[0]!.modelSelection.model, "cheap");
        assert.equal(history.samples[0]!.provenance, "agent-reported");
        yield* service.runCheck({ id: config.id });
        const next = yield* service.report(f.caller(), {
          samples: [{ ...sample, version: 2, unit: "percent" }],
          findings: [{ title: "Database queries are slow", evidence: "Same backlog" }],
          summary: "Still slow",
        });
        assert.equal(next.findings.filter((finding) => finding.metricId === null).length, 1);
      }),
    ),
);

it.effect(
  "pauses scheduling, allows measure-only manual checks, resumes without backfill, and retains unresolved history on retirement",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runDue;
        assert.equal(f.counts().launches, 0);
        yield* service.runCheck({ id: config.id });
        assert.isTrue((yield* service.checkContext(f.caller())).measureOnly);
        const reported = yield* service.report(f.caller(), {
          samples: [sample],
          findings: [],
          summary: "Paused measurement",
        });
        const finding = reported.findings[0]!;
        yield* refused(
          service.guardDelegation({
            ownerThreadId: f.caller().threadId,
            clientRequestId: "repair:test",
            request: {
              role: "implementation-worker",
              taskClass: "non-ui",
              workId: finding.workId,
              attemptId: finding.attemptId,
              workspacePath: "/isolated",
              workspaceAssignment: "isolated",
            },
          }),
        );
        yield* TestClock.adjust("1 day");
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        yield* service.runDue;
        assert.equal(f.counts().launches, 1);
        yield* service.setLifecycle({ id: config.id, lifecycle: "retired" });
        yield* refused(service.runCheck({ id: config.id }));
        assert.equal((yield* service.get({ id: config.id })).findings.length, 1);
      }),
    ),
);

it.effect("retries the durable check claim after model refusal without selecting a fallback", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      f.available(false);
      yield* service.runCheck({ id: config.id });
      assert.equal(f.counts().launches, 0);
      const first = yield* service.get({ id: config.id });
      assert.isNotNull(first.champion.outstandingCheckId);
      f.available(true);
      yield* service.runDue;
      assert.equal(f.counts().launches, 1);
      assert.equal(f.counts().sends, 0);
      assert.equal(
        (yield* service.get({ id: config.id })).champion.outstandingCheckId,
        first.champion.outstandingCheckId,
      );
    }),
  ),
);

it.effect(
  "replays an uncertain launch using its original launch command and message rather than sending a second message",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        f.failNextLaunch();
        yield* service.runCheck({ id: config.id });
        assert.equal(f.counts().launches, 1);
        assert.isNotNull((yield* service.get({ id: config.id })).champion.outstandingCheckId);
        yield* service.runDue;
        assert.equal(f.counts().launches, 2);
        assert.equal(f.counts().sends, 0);
        assert.deepEqual(f.launchRequests[0], f.launchRequests[1]);
        assert.isNull((yield* service.get({ id: config.id })).champion.lastCheckAt);
      }),
    ),
);

it.effect(
  "guards repair identity/project/isolation/concurrency, binds accepted children and requires comparable delivered-revision evidence",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        yield* service.runCheck({ id: config.id });
        const result = yield* service.report(f.caller(), {
          samples: [sample],
          findings: [{ title: "Slow queries", evidence: "Observed backlog" }],
          summary: "Two repairs",
        });
        const finding = result.findings[0]!;
        const request = {
          role: "implementation-worker" as const,
          taskClass: "non-ui" as const,
          workId: finding.workId,
          attemptId: finding.attemptId,
          workspacePath: "/isolated",
          workspaceAssignment: "isolated" as const,
        };
        const guard = (overrides = {}) =>
          service.guardDelegation({
            ownerThreadId: f.caller().threadId,
            clientRequestId: "repair:first",
            request: { ...request, ...overrides },
          });
        yield* refused(guard({ workId: "invented" }));
        yield* refused(guard({ projectId: ProjectId.make("another-project") }));
        yield* refused(guard({ workspaceAssignment: "lead" }));
        yield* guard();
        yield* guard();
        yield* refused(
          service.guardDelegation({
            ownerThreadId: f.caller().threadId,
            clientRequestId: "duplicate-child",
            request,
          }),
        );
        yield* refused(
          guard({ workId: result.findings[1]!.workId, attemptId: result.findings[1]!.attemptId }),
        );
        yield* refused(
          service.updateDelivery(f.caller(), {
            findingId: finding.id,
            action: "handed_back",
            revision: "abc123",
            evidence: "Model claim without accepted child",
          }),
        );
        f.installChild(finding, "abc123");
        f.wake();
        yield* refused(
          service.report(f.caller(), {
            samples: [sample],
            findings: [],
            summary: "Wrong message claim",
          }),
        );
        const delivered = yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "handed_back",
          revision: "abc123",
          evidence: "Accepted child returned revision",
        });
        assert.equal(
          delivered.findings[0]!.childThreadId,
          ThreadId.make("accepted:implementation-worker"),
        );
        yield* refused(
          service.updateDelivery(f.caller(), {
            findingId: finding.id,
            action: "delivered",
            revision: "abc123",
            evidence: "No actual landing operation",
          }),
        );
        f.installChild(finding, "review clean", "ticket-reviewer");
        f.setLanding("abc123", "1970-01-01T00:00:00.000Z");
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "delivered",
          operationId: "op_confirmed",
          revision: "abc123",
          evidence: "SlipJay confirmed publication",
        });
        const inconclusive = yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "verify",
          evidence: "No later measurement on delivered revision",
        });
        assert.equal(inconclusive.findings[0]!.status, "inconclusive");
        yield* service.propose({
          id: config.id,
          metrics: [{ ...metric, maximum: 4 }],
          reason: "Relax target without changing series",
        });
        yield* service.accept({ id: config.id });
        yield* TestClock.adjust("1 second");
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
          samples: [
            {
              ...sample,
              version: 2,
              value: 3.5,
              revision: "abc123",
              observedAt: "1970-01-01T00:00:01.000Z",
            },
          ],
          findings: [],
          summary: "Target relaxed but product worsened",
        });
        const unchanged = yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "verify",
          evidence: "Do not confuse a relaxed target with improvement",
        });
        assert.equal(unchanged.findings[0]!.status, "inconclusive");
        yield* TestClock.adjust("1 second");
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
          samples: [
            {
              ...sample,
              version: 2,
              value: 1,
              revision: "abc123",
              observedAt: "1970-01-01T00:00:02.000Z",
            },
          ],
          findings: [],
          summary: "Improved on delivered revision",
        });
        const verified = yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "verify",
          evidence: "Comparable delivered-revision measurement",
        });
        assert.equal(verified.findings.find((f) => f.id === finding.id)!.status, "verified");
      }),
    ),
);

it.effect(
  "records explicit null observations and rejects misleading or nonfinite measurements",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        for (const invalid of [
          { ...sample, value: null },
          { ...sample, value: Number.NaN },
          { ...sample, status: "unknown" as const },
          { ...sample, version: 999 },
        ])
          yield* refused(
            service.report(f.caller(), { samples: [invalid], findings: [], summary: "Invalid" }),
          );
        const result = yield* service.report(f.caller(), {
          samples: [{ ...sample, value: null, status: "insufficient" }],
          findings: [],
          summary: "No trustworthy observation",
        });
        assert.equal(result.findings.length, 0);
        assert.isTrue(result.champion.attention.some((a) => a.includes("insufficient")));
        const history = yield* service.history({ id: config.id });
        assert.equal(history.samples[0]!.value, null);
        assert.equal(history.samples[0]!.status, "insufficient");
      }),
    ),
);

it.effect(
  "recovers pending claims after service reconstruction and preserves the owner namespace",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const original = yield* definitions(service);
        f.failNextLaunch();
        const pending = yield* service.runCheck({ id: config.id });
        yield* Effect.gen(function* () {
          const recovered = yield* Champions.ChampionService;
          yield* recovered.runDue;
          const doc = yield* recovered.get({ id: config.id });
          assert.equal(doc.champion.ownerThreadId, original.champion.ownerThreadId);
          assert.equal(doc.champion.outstandingCheckId, pending.champion.outstandingCheckId);
          assert.deepEqual(f.launchRequests[0], f.launchRequests[1]);
        }).pipe(Effect.provide(Layer.fresh(f.layer)));
      }),
    ),
);

it.effect(
  "keeps setup separate from the routine owner and preserves pending user acceptance without freezing the routine check",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
        const routine = yield* service.runCheck({ id: config.id });
        const setup = yield* service.setup({ id: config.id });
        assert.equal(setup.champion.outstandingCheckId, routine.champion.outstandingCheckId);
        assert.isNotNull(setup.champion.outstandingSetupId);
        assert.notEqual(setup.champion.setupThreadId, setup.champion.ownerThreadId);
        assert.equal(f.launchRequests[0]!.model, "cheap");
        assert.equal(f.launchRequests[1]!.model, "strong");
        const proposal = yield* service.proposeFromSetup(f.caller(), {
          metrics: [{ ...metric, maximum: 1 }],
          reason: "Stronger setup proposes a tighter goal",
        });
        assert.isTrue(proposal.champion.pendingProposal);
        assert.isNull(proposal.champion.outstandingSetupId);
        assert.equal(proposal.champion.outstandingCheckId, routine.champion.outstandingCheckId);
        assert.equal(proposal.metrics[0]!.maximum, 2);
      }),
    ),
);

it.effect(
  "lets an explicit manual retry recover an ended run without claiming the dispatch succeeded",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        const pending = yield* service.runCheck({ id: config.id });
        yield* service.runCheck({ id: config.id });
        assert.equal(f.counts().sends, 0);
        f.endRun();
        const retried = yield* service.runCheck({ id: config.id });
        assert.equal(retried.champion.ownerThreadId, pending.champion.ownerThreadId);
        assert.equal(retried.champion.outstandingCheckId, pending.champion.outstandingCheckId);
        assert.equal(f.counts().sends, 1);
        assert.isNull(retried.champion.lastCheckAt);
        const report = yield* service.report(f.caller(), {
          samples: [sample],
          findings: [],
          summary: "Retry produced an authenticated observation",
        });
        assert.isNull(report.champion.outstandingCheckId);
        assert.isNotNull(report.champion.lastCheckAt);
      }),
    ),
);

const activeFinding = Effect.fn("test.activeChampionFinding")(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
  service: Champions.ChampionService["Service"],
) {
  yield* definitions(service);
  yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
  yield* service.runCheck({ id: config.id });
  const report = yield* service.report(f.caller(), {
    samples: [sample],
    findings: [],
    summary: "An ordinary repair",
  });
  assert.deepEqual(report.champion.attention, []);
  return report.findings[0]!;
});
const repair = (finding: ChampionFinding) => ({
  role: "implementation-worker" as const,
  taskClass: "non-ui" as const,
  workId: finding.workId,
  attemptId: finding.attemptId,
  workspacePath: "/isolated",
  workspaceAssignment: "isolated" as const,
});

it.effect(
  "keeps healthy repair and ordinary inconclusive verification quiet, while decisions resolve once and wake the owner",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        const request = repair(finding);
        yield* service.guardDelegation({
          ownerThreadId: f.caller().threadId,
          request,
          clientRequestId: "implementation",
        });
        assert.deepEqual((yield* service.get({ id: config.id })).champion.attention, []);
        f.installChild(finding, "handoff");
        yield* service.runDue;
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "inconclusive",
          evidence: "Not enough comparable data yet",
        });
        assert.deepEqual((yield* service.get({ id: config.id })).champion.attention, []);
        const requested = yield* service.findingAction(
          {
            id: config.id,
            findingId: finding.id,
            action: "decision",
            reason: "Should this target include weekends?",
          },
          "agent",
        );
        const decision = requested.findings.find((x) => x.id === finding.id)!.decision!;
        assert.equal(decision.status, "requested");
        assert.isTrue(requested.champion.attention.some((a) => a.startsWith("Decision:")));
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
          samples: [{ ...sample, value: 1 }],
          findings: [],
          summary: "Checks continue while a decision waits",
        });
        const answer = {
          id: config.id,
          findingId: finding.id,
          action: "resolve_decision" as const,
          decisionId: decision.id,
          reason: "Include weekends.",
        };
        yield* refused(service.findingAction(answer, "agent"));
        const resolved = yield* service.findingAction(answer);
        assert.equal(
          resolved.findings.find((x) => x.id === finding.id)!.decision!.answer,
          "Include weekends.",
        );
        assert.deepEqual(resolved.champion.attention, []);
        yield* service.findingAction(answer);
        assert.equal(
          f.sent.filter((x) => x.commandId === `champion-decision:${decision.id}`).length,
          1,
        );
      }),
    ),
);

it.effect(
  "persists a resolved decision through an uncertain owner send and retries its deterministic delivery",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        const doc = yield* service.findingAction({
          id: config.id,
          findingId: finding.id,
          action: "decision",
          reason: "Use a tighter limit?",
        });
        const decisionId = doc.findings[0]!.decision!.id;
        f.failDecisionSend(true);
        const pending = yield* service.findingAction({
          id: config.id,
          findingId: finding.id,
          action: "resolve_decision",
          decisionId,
          reason: "Keep the existing limit.",
        });
        assert.equal(pending.findings[0]!.decision!.status, "resolved");
        assert.isTrue(pending.champion.attention.some((a) => a.includes("delivery pending")));
        f.failDecisionSend(false);
        yield* service.runDue;
        assert.deepEqual((yield* service.get({ id: config.id })).champion.attention, []);
        assert.equal(f.sent.at(-1)!.commandId, `champion-decision:${decisionId}`);
      }),
    ),
);

it.effect(
  "releases refused reservations, preserves uncertainty and permits only the same dispatch identity to replay",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        const input = {
          ownerThreadId: f.caller().threadId,
          request: repair(finding),
          clientRequestId: "repair-stable",
        };
        yield* service.guardDelegation(input);
        yield* service.delegationOutcome({ ...input, state: "failed" });
        const rejected = yield* service.get({ id: config.id });
        assert.equal(rejected.findings[0]!.status, "open");
        assert.isTrue(rejected.champion.attention.some((a) => a.includes("refused")));
        yield* service.guardDelegation(input);
        const commandId = CommandId.make("repair-command");
        yield* service.delegationOutcome({ ...input, state: "started", commandId });
        yield* service.delegationOutcome({ ...input, state: "failed" });
        assert.isTrue(
          (yield* service.get({ id: config.id })).champion.attention.some((a) =>
            a.includes("uncertain"),
          ),
        );
        yield* refused(service.guardDelegation({ ...input, clientRequestId: "duplicate" }));
        yield* service.guardDelegation(input);
        f.setReceipt(commandId, "rejected");
        yield* service.runDue;
        yield* service.guardDelegation(input);
        f.installChild(finding, "abc123");
        yield* service.delegationOutcome({ ...input, state: "started", commandId });
        f.setReceipt(commandId, "accepted");
        yield* service.delegationOutcome({ ...input, state: "failed" });
        yield* service.runDue;
        assert.equal(
          (yield* service.get({ id: config.id })).findings[0]!.childThreadId,
          ThreadId.make("accepted:implementation-worker"),
        );
        assert.deepEqual((yield* service.get({ id: config.id })).champion.attention, []);
      }),
    ),
);

it.effect(
  "supports implementation, independent review and fix followups without duplicating implementers or replacing handoff ownership",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        const ownerThreadId = f.caller().threadId;
        const implement = { ownerThreadId, request: repair(finding), clientRequestId: "implement" };
        yield* service.guardDelegation(implement);
        f.installChild(finding, "author-commit");
        yield* service.delegationOutcome({ ...implement, state: "finished" });
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "handed_back",
          revision: "author-commit",
          evidence: "Worker returned its pinned contribution",
        });
        const review = {
          ownerThreadId,
          clientRequestId: "review",
          request: {
            ...repair(finding),
            role: "ticket-reviewer" as const,
            readOnly: true,
            sourceRevision: "author-commit",
            review: {
              scope: "change" as const,
              baseRevision: "base",
              includedChanges: ["author-commit"],
              coverage: "complete" as const,
            },
          },
        };
        yield* service.guardDelegation(review);
        f.installChild(finding, "Needs one fix", "ticket-reviewer");
        yield* service.delegationOutcome({ ...review, state: "finished" });
        yield* service.guardDelegation({
          ...implement,
          followup: true,
          clientRequestId: "fix-followup",
        });
        f.installChild(finding, "fixed-commit");
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "handed_back",
          revision: "fixed-commit",
          evidence: "Fix returned on same implementation child",
        });
        yield* service.guardDelegation({
          ...review,
          followup: true,
          clientRequestId: "review-followup",
        });
        f.installChild(finding, "Clean review", "ticket-reviewer");
        yield* service.runDue;
        assert.equal(
          (yield* service.get({ id: config.id })).findings[0]!.childThreadId,
          ThreadId.make("accepted:implementation-worker"),
        );
        yield* refused(
          service.updateDelivery(f.caller(), {
            findingId: finding.id,
            action: "delivered",
            revision: "fixed-commit",
            evidence: "A returned author commit alone is not landing",
          }),
        );
        f.setLanding("integration-commit", "1970-01-01T00:00:01.000Z");
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "delivered",
          revision: "integration-commit",
          operationId: "op_real_landing",
          evidence: "Owner adopted and landed through SlipJay",
        });
        yield* TestClock.adjust("2 seconds");
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
          samples: [{ ...sample, value: 1, revision: "integration-commit" }],
          findings: [],
          summary: "Cached pre-delivery observation",
        });
        const stale = yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "verify",
          evidence: "Cache is not improvement evidence",
        });
        assert.equal(stale.findings.find((x) => x.id === finding.id)!.status, "inconclusive");
        yield* TestClock.adjust("1 second");
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
          samples: [
            {
              ...sample,
              value: 1,
              revision: "integration-commit",
              observedAt: "1970-01-01T00:00:03.000Z",
            },
          ],
          findings: [],
          summary: "Fresh running-revision observation",
        });
        const verified = yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "verify",
          evidence: "Fresh comparable evidence",
        });
        assert.equal(verified.findings.find((x) => x.id === finding.id)!.status, "verified");
      }),
    ),
);

it.effect(
  "routes advice to the explicit stronger selection and permits the normal Forge Spec lead workspace allocation contract",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        const ownerThreadId = f.caller().threadId;
        const advisor = {
          ownerThreadId,
          clientRequestId: "advice",
          request: {
            ...repair(finding),
            role: "advisor" as const,
            readOnly: true,
            sourceRevision: "base",
          },
        };
        const selection = yield* service.guardDelegation(advisor);
        assert.equal(selection?.model, "strong");
        f.installChild(finding, "Challenge recorded", "advisor");
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "spec",
          specUrl: "https://weave.example/forge/6366",
          evidence: "Advisor challenge shaped the Spec",
        });
        const leadRequest = {
          ...repair(finding),
          role: "lead" as const,
          workspacePath: "/project/root",
          workspaceAssignment: undefined,
        };
        yield* refused(
          service.guardDelegation({ ownerThreadId, clientRequestId: "lead", request: leadRequest }),
        );
        yield* service.guardDelegation({
          ownerThreadId,
          clientRequestId: "lead",
          request: leadRequest,
          forgeItem: 6366,
        });
        yield* refused(
          service.guardDelegation({
            ownerThreadId,
            clientRequestId: "lead",
            request: { ...leadRequest, workspaceAssignment: "isolated" },
            forgeItem: 6366,
          }),
        );
        const continuation = {
          ownerThreadId,
          request: leadRequest,
          followup: true,
          clientRequestId: "lead-continuation",
          childThreadId: ThreadId.make("accepted:lead"),
        };
        f.installChild(finding, "lead-result", "lead", "completed", {
          number: 6366,
          itemId: "spec-id",
          origin: "https://weave.example",
        });
        yield* service.guardDelegation(continuation);
        yield* refused(
          service.guardDelegation({
            ...continuation,
            childThreadId: ThreadId.make("foreign-child"),
          }),
        );
        f.installChild(finding, "lead-result", "lead", "completed", {
          number: 6367,
          itemId: "another-spec",
          origin: "https://weave.example",
        });
        yield* refused(service.guardDelegation(continuation));
        assert.isNull((yield* service.get({ id: config.id })).findings[0]!.childThreadId);
      }),
    ),
);

it.effect(
  "publishes accepted definitions and reports only after committed data is visible to a real subscriber",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* service.upsert(config);
        const queue = yield* Queue.unbounded<void>();
        yield* service.subscribe({}).pipe(
          Stream.runForEach(() => Queue.offer(queue, undefined)),
          Effect.forkScoped,
        );
        yield* Queue.take(queue);
        yield* service.propose({
          id: config.id,
          metrics: [metric],
          reason: "Accept these metrics",
        });
        yield* Queue.take(queue);
        yield* service.accept({ id: config.id });
        yield* Queue.take(queue);
        assert.equal((yield* service.get({ id: config.id })).metrics[0]!.version, 1);
        yield* service.runCheck({ id: config.id });
        yield* Queue.take(queue);
        yield* service.report(f.caller(), {
          samples: [sample],
          findings: [],
          summary: "Committed report",
        });
        yield* Queue.take(queue);
        const history = yield* service.history({ id: config.id });
        assert.equal(history.samples[0]!.value, 3);
        assert.isNotNull((yield* service.get({ id: config.id })).champion.lastCheckAt);
      }),
    ),
);

it.effect(
  "bounds current findings and evidence while retaining older settled findings in paged history",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        yield* refused(
          service.report(f.caller(), {
            samples: [{ ...sample, evidence: "x".repeat(8001) }],
            findings: [],
            summary: "Oversized observation",
          }),
        );
        const first = yield* service.report(f.caller(), {
          samples: [{ ...sample, value: 0 }],
          findings: Array.from({ length: 20 }, (_, i) => ({
            title: `Problem-${i}`,
            evidence: "Observed once",
          })),
          summary: "Batch 0",
        });
        for (const finding of first.findings)
          yield* service.findingAction({
            id: config.id,
            findingId: finding.id,
            action: "dismiss",
            reason: "Resolved by owner",
          });
        for (let batch = 1; batch < 6; batch += 1) {
          yield* TestClock.adjust("1 second");
          yield* service.runCheck({ id: config.id });
          const report = yield* service.report(f.caller(), {
            samples: [{ ...sample, value: 0 }],
            findings: Array.from({ length: 20 }, (_, i) => ({
              title: `Problem-${batch * 20 + i}`,
              evidence: "Observed once",
            })),
            summary: `Batch ${batch}`,
          });
          for (const finding of report.findings.filter((x) => x.status === "open"))
            yield* service.findingAction({
              id: config.id,
              findingId: finding.id,
              action: "dismiss",
              reason: "Resolved by owner",
            });
        }
        assert.equal((yield* service.get({ id: config.id })).findings.length, 100);
        const old = yield* service.history({
          id: config.id,
          before: "1970-01-01T00:00:00.001Z",
          limit: 100,
        });
        assert.equal(old.findings?.length, 20);
        assert.isTrue(old.samples.every((x) => x.evidence.length <= 8000));
      }),
    ),
);

it.effect(
  "does not decode unrelated champion documents while authorizing an ordinary unrelated thread",
  () =>
    withFixture((_f, service) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO champions(id,project_id,document_json) VALUES ('unrelated','project', '{"champion":{"ownerThreadId":"unrelated-owner","setupThreadId":null},"findings":"corrupt history"}')`.pipe(
          Effect.orDie,
        );
        yield* service.guardDelegation({
          ownerThreadId: ThreadId.make("ordinary-thread"),
          request: undefined,
          clientRequestId: undefined,
        });
      }),
    ),
);

it.effect(
  "exposes compact latest readings independent of activity pagination and never marks stale or older-definition readings healthy",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
          samples: [{ ...sample, value: 1 }],
          findings: [],
          summary: "Healthy current observation",
        });
        const first = (yield* service.list({})).champions[0]!.latestSamples![0]!;
        assert.equal(first.health, "healthy");
        assert.isFalse("evidence" in first);
        yield* TestClock.adjust("3 minutes");
        assert.equal((yield* service.list({})).champions[0]!.latestSamples![0]!.health, "stale");
        assert.equal((yield* service.get({ id: config.id })).latestSamples![0]!.health, "stale");
        yield* service.propose({
          id: config.id,
          metrics: [{ ...metric, required: false, baseline: 5, staleAfterMs: 1000 }],
          reason: "Optional goal with an explicit baseline",
        });
        yield* service.accept({ id: config.id });
        assert.equal((yield* service.get({ id: config.id })).latestSamples![0]!.health, "unknown");
        yield* service.runCheck({ id: config.id });
        const optional = yield* service.report(f.caller(), {
          samples: [],
          findings: [],
          summary: "No optional observation this time",
        });
        assert.deepEqual(optional.champion.attention, []);
        assert.equal(optional.metrics[0]!.baseline, 5);
        assert.equal(optional.metrics[0]!.required, false);
      }),
    ),
);

it.effect(
  "discards proposals without changing accepted versions and completes or cancels setup without fabricating a proposal",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const accepted = yield* definitions(service);
        yield* service.propose({
          id: config.id,
          metrics: [{ ...metric, maximum: 1 }],
          reason: "Pending tighter goal",
        });
        const discarded = yield* service.discardProposal({ id: config.id });
        assert.isNull(discarded.proposal);
        assert.deepEqual(discarded.metrics, accepted.metrics);
        const setup = yield* service.setup({ id: config.id });
        assert.isNotNull(setup.champion.outstandingSetupId);
        const complete = yield* service.completeSetup(f.caller(), {
          summary: "Existing accepted definitions remain appropriate.",
        });
        assert.isNull(complete.champion.outstandingSetupId);
        assert.isNull(complete.proposal);
        assert.deepEqual(complete.metrics, accepted.metrics);
        yield* service.setup({ id: config.id });
        const cancelled = yield* service.cancelSetup({ id: config.id });
        assert.isNull(cancelled.champion.outstandingSetupId);
        assert.deepEqual(cancelled.metrics, accepted.metrics);
        yield* refused(
          service.proposeFromSetup(f.caller(), {
            metrics: [metric],
            reason: "Old cancelled caller",
          }),
        );
        yield* service.setup({ id: config.id });
        const proposed = yield* service.proposeFromSetup(f.caller(), {
          metrics: [{ ...metric, maximum: 1 }],
          reason: "A later setup may propose again",
        });
        assert.isNotNull(proposed.proposal);
        assert.deepEqual(proposed.metrics, accepted.metrics);
      }),
    ),
);

it.effect(
  "keeps failed preflight followups from rewriting an existing phase and exposes the stable identity of an uncertain followup",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        const initial = {
          ownerThreadId: f.caller().threadId,
          request: repair(finding),
          clientRequestId: "first-implementation",
        };
        yield* service.guardDelegation(initial);
        f.installChild(finding, "first-commit");
        yield* service.delegationOutcome({ ...initial, state: "finished" });
        yield* service.runDue;
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "handed_back",
          revision: "first-commit",
          evidence: "Initial handoff",
        });
        const followup = { ...initial, followup: true, clientRequestId: "fix-followup" };
        yield* service.guardDelegation(followup);
        yield* service.delegationOutcome({ ...followup, state: "failed" });
        assert.equal((yield* service.get({ id: config.id })).findings[0]!.status, "handed_back");
        const commandId = CommandId.make("followup-command");
        yield* service.delegationOutcome({ ...followup, state: "started", commandId });
        f.installChild(finding, "", "implementation-worker", "running");
        yield* service.delegationOutcome({ ...followup, state: "failed" });
        const uncertain = yield* service.get({ id: config.id });
        assert.isTrue(uncertain.champion.attention.some((a) => a.includes("fix-followup")));
        yield* service.delegationOutcome({
          ...initial,
          clientRequestId: "unrelated-rejected-request",
          state: "failed",
        });
        assert.deepEqual(
          (yield* service.get({ id: config.id })).champion.attention,
          uncertain.champion.attention,
        );
        f.installChild(finding, "fixed-commit");
        f.setReceipt(commandId, "accepted");
        yield* service.runDue;
        assert.deepEqual((yield* service.get({ id: config.id })).champion.attention, []);
        const handedBack = yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "handed_back",
          revision: "fixed-commit",
          evidence: "Same implementation child returned the fix",
        });
        assert.isNull(handedBack.findings[0]!.delivery);
      }),
    ),
);

it.effect(
  "refreshes expired readings for a paused subscriber without inventing inbox attention, and cancels setup before dispatch begins",
  () =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        yield* definitions(service);
        yield* service.runCheck({ id: config.id });
        yield* service.report(f.caller(), {
          samples: [{ ...sample, value: 1 }],
          findings: [],
          summary: "Paused manual reading",
        });
        const queue = yield* Queue.unbounded<void>();
        yield* service.subscribe({}).pipe(
          Stream.runForEach(() => Queue.offer(queue, undefined)),
          Effect.forkScoped,
        );
        yield* Queue.take(queue);
        yield* TestClock.adjust("3 minutes");
        yield* service.runDue;
        yield* Queue.take(queue);
        const stale = (yield* service.list({})).champions[0]!;
        assert.equal(stale.latestSamples![0]!.health, "stale");
        assert.deepEqual(stale.attention, []);
        f.available(false);
        const draft = yield* service.setup({ id: config.id });
        assert.isNotNull(draft.champion.outstandingSetupId);
        const cancelled = yield* service.cancelSetup({ id: config.id });
        assert.isNull(cancelled.champion.outstandingSetupId);
      }),
    ),
);

it.effect("rejects incompatible measured sources without changing history or health", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      yield* definitions(service);
      yield* service.setLifecycle({ id: config.id, lifecycle: "active" });
      yield* service.runCheck({ id: config.id });
      yield* refused(
        service.report(f.caller(), {
          samples: [{ ...sample, source: "synthetic", value: 0 }],
          findings: [],
          summary: "Wrong source",
        }),
      );
      assert.deepEqual((yield* service.history({ id: config.id })).samples, []);
      assert.isNull((yield* service.get({ id: config.id })).champion.lastCheckAt);
      const accepted = yield* service.report(f.caller(), {
        samples: [{ ...sample, evidence: "https://evidence.example/logs" }],
        findings: [],
        summary: "Real logs",
      });
      assert.equal((yield* service.history({ id: config.id })).samples[0]!.source, "logs");
      assert.equal(accepted.findings.length, 1);
    }),
  ),
);

it.effect.each(["failed", "cancelled", "interrupted"])(
  "charges an accepted %s repair against the daily budget after reconciliation",
  (status) =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        yield* service.upsert({ ...config, charter: { ...config.charter, maxRepairsPerDay: 1 } });
        const input = {
          ownerThreadId: f.caller().threadId,
          request: repair(finding),
          clientRequestId: "first",
        };
        yield* service.guardDelegation(input);
        yield* service.delegationOutcome({ ...input, state: "finished" });
        f.installChild(finding, "failed-revision", "implementation-worker", status);
        yield* service.runDue;
        const reopened = yield* service.findingAction({
          id: config.id,
          findingId: finding.id,
          action: "reopen",
          reason: "Retry",
        });
        yield* refused(
          service.guardDelegation({
            ...input,
            request: repair(reopened.findings[0]!),
            clientRequestId: "second",
          }),
        );
      }),
    ),
);

it.effect.each(["reopen", "decision"] as const)(
  "fetches landing evidence outside the mutation lock and rejects a concurrent %s",
  (action) =>
    withFixture((f, service) =>
      Effect.gen(function* () {
        const finding = yield* activeFinding(f, service);
        f.installChild(finding, "delivered-revision");
        yield* service.updateDelivery(f.caller(), {
          findingId: finding.id,
          action: "handed_back",
          revision: "delivered-revision",
          evidence: "Child handoff",
        });
        f.setLanding("delivered-revision", "1970-01-01T00:00:01.000Z");
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.blockLanding(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        const delivery = yield* service
          .updateDelivery(f.caller(), {
            findingId: finding.id,
            action: "delivered",
            revision: "delivered-revision",
            operationId: "operation",
            evidence: "Runner evidence",
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* service.upsert({ ...config, name: "Updated during lookup" });
        yield* service.findingAction({
          id: config.id,
          findingId: finding.id,
          action,
          reason: "New attempt",
        });
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(delivery);
        assert.equal(result._tag, "Failure");
        const current = yield* service.get({ id: config.id });
        assert.equal(current.champion.name, "Updated during lookup");
        assert.equal(current.findings[0]!.status, action === "reopen" ? "open" : "handed_back");
        assert.isNull(current.findings[0]!.delivery);
      }),
    ),
);

it.effect("charges uncertainty, releases genuine refusals and counts stable replays once", () =>
  withFixture((f, service) =>
    Effect.gen(function* () {
      const first = yield* activeFinding(f, service);
      yield* service.upsert({
        ...config,
        charter: { ...config.charter, maxConcurrentRepairs: 3, maxRepairsPerDay: 1 },
      });
      yield* service.runCheck({ id: config.id });
      const report = yield* service.report(f.caller(), {
        samples: [sample],
        findings: [{ title: "Database backlog", evidence: "Observed" }],
        summary: "More work",
      });
      const second = report.findings.find((finding) => finding.id !== first.id)!;
      const initial = {
        ownerThreadId: f.caller().threadId,
        request: repair(first),
        clientRequestId: "first",
      };
      const next = { ...initial, request: repair(second), clientRequestId: "second" };
      yield* service.guardDelegation(initial);
      yield* service.delegationOutcome({
        ...initial,
        state: "started",
        commandId: CommandId.make("uncertain"),
      });
      yield* refused(service.guardDelegation(next));
      f.setReceipt("uncertain", "rejected");
      yield* service.delegationOutcome({
        ...initial,
        state: "failed",
        commandId: CommandId.make("uncertain"),
      });
      yield* service.guardDelegation(next);
      yield* service.delegationOutcome({ ...next, state: "finished" });
      yield* service.guardDelegation(next);
      yield* service.delegationOutcome({ ...next, state: "finished" });
      yield* refused(service.guardDelegation(initial));
      yield* service.upsert({
        ...config,
        charter: { ...config.charter, maxConcurrentRepairs: 3, maxRepairsPerDay: 2 },
      });
      yield* service.guardDelegation(initial);
    }),
  ),
);
