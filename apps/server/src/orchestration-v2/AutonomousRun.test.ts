import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ForgeWorkItems from "../weave/ForgeWorkItems.ts";
import * as ThreadMetadataMcp from "../mcp/ThreadMetadataMcpService.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ArcRunReactor from "./ArcRunReactor.ts";
import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as UnattendedReactor from "./UnattendedReactor.ts";
import {
  appendDecisionLogEntry,
  ARC_RUN_NO_PROGRESS_CAP,
  arcRunAttentionMessage,
  describeUnattendedTurnNote,
  hasDoneStatusMarker,
  isCoveredByAway,
  MAX_DECISION_LOG_ENTRIES,
} from "./arcRun.ts";
import {
  ARC_RUN_WAKE_MESSAGE_PREFIX,
  UNATTENDED_CONTINUATION_MESSAGE_PREFIX,
} from "./serverContinuation.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerBase = Layer.mergeAll(
  layerDatabase,
  NodeCrypto.layer,
  ServerSettings.ServerSettingsService.layerTest(),
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "autonomous-run" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerTest = Layer.mergeAll(
  ArcRunReactor.layer,
  UnattendedReactor.layer,
  DelegatedTaskQuestionReactor.layer,
).pipe(Layer.provideMerge(layerBase));

const createThread = Effect.fn(function* (id: string, title = "Thread") {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(`thread:${id}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`cmd:create:${id}`),
    threadId,
    projectId: ProjectId.make("project:test"),
    title,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

const completeTurnWithAssistantText = Effect.fn(function* (
  threadId: ThreadId,
  suffix: string,
  assistantText: string,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const messageId = MessageId.make(`msg:${suffix}`);
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`cmd:msg:${suffix}`),
    threadId,
    messageId,
    text: "Work",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
  const run = runs.find((candidate) => candidate.userMessageId === messageId)!;
  const now = yield* DateTime.now;
  const assistantMsgId = MessageId.make(`asst:${suffix}`);
  const completedEvent: OrchestrationV2DomainEvent = {
    type: "run.updated",
    id: EventId.make(`evt:complete:${suffix}`),
    threadId,
    runId: run.id,
    providerInstanceId: instanceId,
    occurredAt: now,
    payload: { ...run, status: "completed", startedAt: now, completedAt: now },
  };
  yield* sink.write({
    events: [
      {
        type: "message.updated",
        id: EventId.make(`evt:asst:${suffix}`),
        threadId,
        runId: run.id,
        ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: {
          id: assistantMsgId,
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          role: "assistant",
          createdBy: "agent",
          creationSource: "provider",
          text: assistantText,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      },
      completedEvent,
    ],
  });
  return { run, completedEvent };
});

it("hasDoneStatusMarker recognises canonical 🟢 Status: Done lines only", () => {
  assert.isTrue(hasDoneStatusMarker("Summary.\n\n🟢 Status: Done — landed."));
  assert.isTrue(hasDoneStatusMarker("🟢 Status: Done"));
  assert.isFalse(hasDoneStatusMarker("🟡 Status: Checkpoint — step 1 done."));
  assert.isFalse(hasDoneStatusMarker("🔴 Status: Waiting on you."));
  assert.isFalse(hasDoneStatusMarker("I finished step 1; should I proceed to step 2?"));
  assert.isFalse(hasDoneStatusMarker(undefined));
});

it("describeUnattendedTurnNote injects authority for Away, Arc, Spec and task runs and skips wakes/helpers", () => {
  const topLevel = {
    lineage: { parentThreadId: null, relationshipToParent: null },
    agentTask: undefined,
    arcRun: undefined,
    autonomousRun: undefined,
  };
  const awayNote = describeUnattendedTurnNote({ thread: topLevel, away: true });
  assert.include(awayNote, "Global Away is on");
  assert.include(awayNote, "Production deploys or migrations");
  assert.include(awayNote, "op decision");
  assert.notInclude(awayNote, "consult the advisor");

  assert.strictEqual(describeUnattendedTurnNote({ thread: topLevel, away: false }), "");
  assert.strictEqual(
    describeUnattendedTurnNote({ thread: topLevel, away: true, skipForWake: true }),
    "",
  );

  // Read-only helpers never receive the top-level Away note.
  const helper = {
    lineage: {
      parentThreadId: ThreadId.make("thread:parent"),
      relationshipToParent: "subagent" as const,
    },
    agentTask: { role: "scout" as const } as never,
    arcRun: undefined,
    autonomousRun: undefined,
  };
  assert.strictEqual(describeUnattendedTurnNote({ thread: helper, away: true }), "");

  // Active Spec autonomous run injects from turn 1 even when Away is off.
  const now = "2026-11-22T12:00:00.000Z";
  const specRunThread = {
    ...topLevel,
    autonomousRun: {
      kind: "spec" as const,
      spec: { number: 8708, ref: "T3-858" },
      state: "active" as const,
      startedAt: now,
      progressAt: now,
      ceilingSince: now,
    },
  };
  const specNote = describeUnattendedTurnNote({ thread: specRunThread, away: false });
  assert.include(specNote, "Spec T3-858");
  assert.include(specNote, "Unattended authority");
  assert.include(specNote, "op decision");
});

it.effect("away-off exempts a thread from global Away until away-on or a run starts", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("away-opt-out", "Away opt-out");
    const arcRun = (op: "away-off" | "away-on" | "start" | "end", n: number) =>
      orchestrator.dispatch({
        type: "thread.arc-run",
        commandId: CommandId.make(`cmd:away-opt:${op}:${n}`),
        threadId,
        op,
        ...(op === "start" ? { label: "Pinned" } : {}),
      });

    assert.isTrue(isCoveredByAway(yield* projections.getThread(threadId), now));

    yield* arcRun("away-off", 1);
    const off = yield* projections.getThread(threadId);
    assert.isTrue(off.awayOptOut);
    assert.isFalse(isCoveredByAway(off, now));
    assert.strictEqual(describeUnattendedTurnNote({ thread: off, away: true }), "");
    assert.isTrue((yield* projections.getThreadShell(threadId))?.awayOptOut);

    yield* arcRun("away-on", 2);
    const on = yield* projections.getThread(threadId);
    assert.isUndefined(on.awayOptOut);
    assert.isTrue(isCoveredByAway(on, now));
    assert.include(describeUnattendedTurnNote({ thread: on, away: true }), "Global Away is on");

    // Ending a run keeps the opt-out; starting one is an explicit "on" and clears it.
    yield* arcRun("away-off", 3);
    yield* arcRun("end", 4);
    assert.isTrue((yield* projections.getThread(threadId)).awayOptOut);
    yield* arcRun("start", 5);
    const started = yield* projections.getThread(threadId);
    assert.isUndefined(started.awayOptOut);
    assert.strictEqual(started.autonomousRun?.state, "active");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "single-Spec autonomous run enforces per-Spec exclusivity, wakes until op end, and stops waking after end",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const arcReactor = yield* ArcRunReactor.ArcRunReactor;

      const t1 = yield* createThread("spec-run-1", "Spec T3-858");
      const t2 = yield* createThread("spec-run-2", "Duplicate Spec T3-858");

      yield* orchestrator.dispatch({
        type: "thread.arc-run",
        commandId: CommandId.make("cmd:spec:start:1"),
        threadId: t1,
        op: "start",
        spec: { number: 8708, ref: "T3-858" },
      });

      const dup = yield* orchestrator
        .dispatch({
          type: "thread.arc-run",
          commandId: CommandId.make("cmd:spec:start:2"),
          threadId: t2,
          op: "start",
          spec: { number: 8708, ref: "T3-858" },
        })
        .pipe(Effect.flip);
      assert.include(JSON.stringify(dup), "already runs Spec #8708");

      // Stored in additive autonomousRun; arcRun stays undefined for shipped-client safety.
      const shell1 = yield* projections.getThreadShell(t1);
      assert.isUndefined(shell1?.arcRun);
      assert.strictEqual(shell1?.autonomousRun?.kind, "spec");
      assert.strictEqual(shell1?.autonomousRun?.spec?.number, 8708);

      // Completing a turn without op end triggers an autonomous wake.
      const { completedEvent } = yield* completeTurnWithAssistantText(
        t1,
        "s1",
        "Partial progress.",
      );
      yield* arcReactor.handle(completedEvent);
      const afterWake = yield* projections.getThreadRecords(t1, ["messages"]);
      const wake = afterWake.messages.find((m) => m.id.startsWith(ARC_RUN_WAKE_MESSAGE_PREFIX));
      assert.isDefined(wake);
      assert.include(wake!.text, "Spec T3-858");

      // Ending clears autonomousRun and prevents further wakes.
      yield* orchestrator.dispatch({
        type: "thread.arc-run",
        commandId: CommandId.make("cmd:spec:end:1"),
        threadId: t1,
        op: "end",
      });
      const afterEnd = yield* projections.getThread(t1);
      assert.isUndefined(afterEnd.autonomousRun);

      const { completedEvent: doneEvt } = yield* completeTurnWithAssistantText(
        t1,
        "s2",
        "Finished.",
      );
      yield* arcReactor.handle(doneEvt);
      const finalMsgs = (yield* projections.getThreadRecords(t1, ["messages"])).messages.filter(
        (m) => m.id.startsWith(ARC_RUN_WAKE_MESSAGE_PREFIX),
      );
      assert.strictEqual(finalMsgs.length, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "open-ended task autonomous runs run concurrently, pause on Stop, resume on owner message, and log durable decisions",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;

      const t1 = yield* createThread("task-1", "Task 1");
      const t2 = yield* createThread("task-2", "Task 2");

      yield* orchestrator.dispatch({
        type: "thread.arc-run",
        commandId: CommandId.make("cmd:task:start:1"),
        threadId: t1,
        op: "start",
        label: "Audit benchmarks",
      });
      yield* orchestrator.dispatch({
        type: "thread.arc-run",
        commandId: CommandId.make("cmd:task:start:2"),
        threadId: t2,
        op: "start",
        label: "Clean old scripts",
      });

      // Log a decision (idempotent on commandId).
      const decisionCmd = {
        type: "thread.arc-run" as const,
        commandId: CommandId.make("cmd:task:dec:1"),
        threadId: t1,
        op: "decision" as const,
        decision: {
          decision: "Use Bun.sql for read benchmarks",
          alternative: "Keep pg driver",
          why: "Measured 2.1x faster on synthetic fixture",
          howToReverse: "Flip pool import back to pg",
          source: "T3-858",
        },
      };
      yield* orchestrator.dispatch(decisionCmd);
      yield* orchestrator.dispatch({
        type: "thread.arc-run",
        commandId: CommandId.make("cmd:task:ckpt:1"),
        threadId: t1,
        op: "checkpoint",
        phase: "benchmarking",
        note: "Halfway through",
      });

      const mid = yield* projections.getThread(t1);
      assert.strictEqual(mid.autonomousRun?.kind, "task");
      assert.strictEqual(mid.autonomousRun?.checkpoint?.phase, "benchmarking");
      assert.strictEqual(mid.decisionLog?.length, 1);
      assert.strictEqual(mid.decisionLog?.[0]?.decision, "Use Bun.sql for read benchmarks");

      // Attention prompt includes the recorded decision log verbatim.
      const attention = arcRunAttentionMessage({
        arcRun: mid.autonomousRun!,
        reason: "no-progress",
        decisionLog: mid.decisionLog,
      });
      assert.include(attention.text, "Use Bun.sql for read benchmarks");
      assert.include(attention.text, "Flip pool import back to pg");
      assert.include(attention.text, String(ARC_RUN_NO_PROGRESS_CAP));

      // Ending preserves decisionLog for closing-report delivery and t3_thread_read.
      yield* orchestrator.dispatch({
        type: "thread.arc-run",
        commandId: CommandId.make("cmd:task:end:1"),
        threadId: t1,
        op: "end",
      });
      const ended = yield* projections.getThread(t1);
      assert.isUndefined(ended.autonomousRun);
      assert.strictEqual(ended.decisionLog?.length, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "under global Away, a non-run thread ending with 🟢 Status: Done is never nudged, while an unfinished one continues",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const unattended = yield* UnattendedReactor.UnattendedReactor;

      const doneThread = yield* createThread("away-done", "Finished chat");
      const midThread = yield* createThread("away-mid", "Mid-work chat");

      yield* unattended.setAway(true);

      const { completedEvent: doneEvt } = yield* completeTurnWithAssistantText(
        doneThread,
        "done1",
        "All finished.\n\n🟢 Status: Done — nothing pending.",
      );
      yield* unattended.handle(doneEvt);
      const doneCont = (yield* projections.getThreadRecords(doneThread, [
        "messages",
      ])).messages.filter((m) => m.id.startsWith(UNATTENDED_CONTINUATION_MESSAGE_PREFIX));
      assert.strictEqual(doneCont.length, 0);

      // Even a fresh Away sweep leaves a 🟢 Status: Done thread untouched.
      yield* unattended.sweep;
      const doneAfterSweep = (yield* projections.getThreadRecords(doneThread, [
        "messages",
      ])).messages.filter((m) => m.id.startsWith(UNATTENDED_CONTINUATION_MESSAGE_PREFIX));
      assert.strictEqual(doneAfterSweep.length, 0);

      // A thread stopping mid-work without 🟢 Status: Done or an owner hold IS woken to continue.
      const { completedEvent: midEvt } = yield* completeTurnWithAssistantText(
        midThread,
        "mid1",
        "Completed step 1. Want me to proceed to step 2?\n\n🟡 Status: Checkpoint — step 2 remains.",
      );
      yield* unattended.handle(midEvt);
      const midCont = (yield* projections.getThreadRecords(midThread, [
        "messages",
      ])).messages.filter((m) => m.id.startsWith(UNATTENDED_CONTINUATION_MESSAGE_PREFIX));
      assert.strictEqual(midCont.length, 1);
      assert.include(midCont[0]!.text, "🟢 Status: Done");
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "DelegatedTaskQuestionReactor grants decision authority and notifies on approvals when global Away is on (without an Arc run)",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const unattended = yield* UnattendedReactor.UnattendedReactor;
      const questionReactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;

      const parentId = yield* createThread("away-parent", "Parent orchestrator");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("cmd:msg:p1"),
        threadId: parentId,
        messageId: MessageId.make("msg:p1"),
        text: "Delegate work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const parentRun = (yield* projections.getThreadRecords(parentId, ["runs"])).runs[0]!;

      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate:away-child"),
        parentThreadId: parentId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: "Build piece",
        completionWake: "always",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const { subagents } = yield* projections.getThreadRecords(parentId, ["subagents"]);
      const task = subagents.find((candidate) => candidate.childThreadId !== null)!;
      const childId = task.childThreadId!;
      const childRuns = (yield* projections.getThreadRecords(childId, ["runs"])).runs;
      const childRun = childRuns[childRuns.length - 1]!;
      const now = yield* DateTime.now;

      yield* unattended.setAway(true);

      const requestEvent = (kind: "user_input" | "command") =>
        ({
          id: EventId.make(`event:away-child:${kind}`),
          type: "runtime-request.updated",
          threadId: childId,
          runId: childRun.id,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make(`req:away-child:${kind}`),
            nodeId: childRun.rootNodeId!,
            providerTurnId: null,
            nativeRequestRef: null,
            kind,
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        }) satisfies Extract<OrchestrationV2DomainEvent, { type: "runtime-request.updated" }>;

      const qEvt = requestEvent("user_input");
      yield* sink.write({ events: [qEvt] });
      yield* questionReactor.handle(qEvt);

      const aEvt = requestEvent("command");
      yield* sink.write({ events: [aEvt] });
      yield* questionReactor.handle(aEvt);

      const parentMsgs = (yield* projections.getThreadRecords(parentId, ["messages"])).messages;
      const qWake = parentMsgs.find((m) => m.id.includes("req:away-child:user_input"));
      const aWake = parentMsgs.find((m) => m.id.includes("req:away-child:command"));
      assert.isDefined(qWake);
      assert.include(qWake!.text, "You answer for this unattended run");
      assert.notInclude(qWake!.text, "otherwise ask the user");
      assert.isDefined(aWake);
      assert.include(aWake!.text, "blocked on a permission request");
      assert.include(aWake!.text, "Carry on with work that does not depend on it");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("ThreadMetadataMcpService returns decisionLog on op end for autonomous runs", () =>
  Effect.gen(function* () {
    const threadId = yield* createThread("mcp-end", "MCP End Test");
    const metadata = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
    const scope = {
      environmentId: "env:test" as never,
      capabilities: new Set(["orchestration"]),
      thread: { threadId },
    } as never;

    yield* metadata.update(scope, {
      action: "arc_run",
      arcRun: { op: "start", label: "Refactor cache" },
    });
    yield* metadata.update(scope, {
      action: "arc_run",
      arcRun: {
        op: "decision",
        decision: {
          decision: "Use LRU with 500 entries",
          alternative: "Unbounded Map",
          why: "Bounds memory under 10 MB",
          howToReverse: "Change MAX_ENTRIES constant",
        },
      },
    });
    const ended = yield* metadata.update(scope, {
      action: "arc_run",
      arcRun: { op: "end" },
    });
    assert.isUndefined(ended.autonomousRun);
    assert.strictEqual(ended.decisionLog?.length, 1);
    assert.strictEqual(ended.decisionLog?.[0]?.decision, "Use LRU with 500 entries");

    // Starting a brand-new run on the same thread clears the prior ended run's decisionLog,
    // and thread shells never broadcast decisionLog.
    yield* metadata.update(scope, {
      action: "arc_run",
      arcRun: { op: "start", label: "Second run" },
    });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const reloaded = yield* projections.getThread(threadId);
    assert.isUndefined(reloaded.decisionLog);
    const shell = yield* projections.getThreadShell(threadId);
    assert.isDefined(shell);
    assert.isUndefined((shell as Record<string, unknown>).decisionLog);
  }).pipe(
    Effect.provide(
      ThreadMetadataMcp.layer.pipe(
        Layer.provideMerge(
          ThreadManagementService.layer.pipe(
            Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
          ),
        ),
        Layer.provideMerge(Layer.mock(ForgeWorkItems.ForgeWorkItems)({})),
        Layer.provideMerge(layerBase),
      ),
    ),
  ),
);

it.effect(
  "Spec exclusivity prevents overlap in both directions between single-Spec runs and Arc runs",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const arcThread = yield* createThread("arc-overlap-owner", "Arc owner");
      const specThread = yield* createThread("spec-overlap-contender", "Spec contender");

      // 1. Arc run claiming specs [9001, 9002] blocks a single-Spec run on 9001
      yield* orchestrator.dispatch({
        type: "thread.arc-run",
        commandId: CommandId.make("cmd:arc:start-9001"),
        threadId: arcThread,
        op: "start",
        arc: { number: 7601, ref: "T3-ARC-05" },
        specs: [9001, 9002],
      });
      const blockedSpec = yield* Effect.flip(
        orchestrator.dispatch({
          type: "thread.arc-run",
          commandId: CommandId.make("cmd:spec:blocked-9001"),
          threadId: specThread,
          op: "start",
          spec: { number: 9001, ref: "T3-9001" },
        }),
      );
      assert.include(JSON.stringify(blockedSpec), "already runs Spec #9001");

      // 2. End Arc run, start single-Spec run on 9001, then confirm an Arc claiming 9001 is refused
      yield* orchestrator.dispatch({
        type: "thread.arc-run",
        commandId: CommandId.make("cmd:arc:end-9001"),
        threadId: arcThread,
        op: "end",
      });
      yield* orchestrator.dispatch({
        type: "thread.arc-run",
        commandId: CommandId.make("cmd:spec:start-9001"),
        threadId: specThread,
        op: "start",
        spec: { number: 9001, ref: "T3-9001" },
      });
      const blockedArc = yield* Effect.flip(
        orchestrator.dispatch({
          type: "thread.arc-run",
          commandId: CommandId.make("cmd:arc:blocked-9001"),
          threadId: arcThread,
          op: "start",
          arc: { number: 7601, ref: "T3-ARC-05" },
          specs: [9001, 9002],
        }),
      );
      assert.include(JSON.stringify(blockedArc), "already runs Spec #9001");
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "appendDecisionLogEntry caps the log at MAX_DECISION_LOG_ENTRIES keeping newest entries",
  () =>
    Effect.sync(() => {
      let entries: ReadonlyArray<any> = [];
      for (let i = 0; i < MAX_DECISION_LOG_ENTRIES + 5; i++) {
        entries = appendDecisionLogEntry(entries, {
          id: `d:${i}`,
          decision: `Decision ${i}`,
          alternative: "Alt",
          why: "Why",
          howToReverse: "Revert",
          recordedAt: "2026-11-22T15:00:00.000Z",
        });
      }
      assert.strictEqual(entries.length, MAX_DECISION_LOG_ENTRIES);
      assert.strictEqual(entries[0]?.id, "d:5");
      assert.strictEqual(entries[entries.length - 1]?.id, `d:${MAX_DECISION_LOG_ENTRIES + 4}`);
    }),
);

it.effect(
  "DelegatedTaskQuestionReactor does not grant unattended authority under global Away to a snoozed parent",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const unattended = yield* UnattendedReactor.UnattendedReactor;
      const questionReactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;

      const parentId = yield* createThread("settled-away-parent", "Settled Parent");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("cmd:msg:sp1"),
        threadId: parentId,
        messageId: MessageId.make("msg:sp1"),
        text: "Delegate work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const parentRun = (yield* projections.getThreadRecords(parentId, ["runs"])).runs[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate:settled-away-child"),
        parentThreadId: parentId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: "Check thing",
        completionWake: "always",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const { subagents } = yield* projections.getThreadRecords(parentId, ["subagents"]);
      const task = subagents.find((candidate) => candidate.childThreadId !== null)!;
      const childId = task.childThreadId!;
      const childRun = (yield* projections.getThreadRecords(childId, ["runs"])).runs[0]!;
      const now = yield* DateTime.now;

      // Snooze parent for 1 hour, then flip Away on
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("cmd:snooze:parent"),
        threadId: parentId,
        snoozedUntil: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
      });
      yield* unattended.setAway(true);

      const qEvt = {
        id: EventId.make("event:settled-away-child:q"),
        type: "runtime-request.updated",
        threadId: childId,
        runId: childRun.id,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make("req:settled-away-child:q"),
          nodeId: childRun.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      } satisfies Extract<OrchestrationV2DomainEvent, { type: "runtime-request.updated" }>;
      yield* sink.write({ events: [qEvt] });
      yield* questionReactor.handle(qEvt);

      const parentMsgs = (yield* projections.getThreadRecords(parentId, ["messages"])).messages;
      const qWake = parentMsgs.find((m) => m.id.includes("req:settled-away-child:q"));
      assert.isDefined(qWake);
      assert.include(qWake!.text, "otherwise ask the user");
      assert.notInclude(qWake!.text, "You answer for this unattended run");
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "pre-run Away decisions are preserved on run start, returned on end, and cleared only on a subsequent run",
  () =>
    Effect.gen(function* () {
      const metadata = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* createThread("away-prerun-decisions", "Away pre-run decisions");
      const scope = {
        environmentId: "env:test" as never,
        capabilities: new Set(["orchestration"]),
        thread: { threadId },
      } as never;

      // 1. Log a decision under global Away before any run starts
      yield* metadata.update(scope, {
        action: "arc_run",
        arcRun: {
          op: "decision",
          decision: {
            decision: "Keep existing config format",
            alternative: "Migrate to v2 schema",
            why: "No callers need v2 fields yet",
            howToReverse: "Add additive migration later",
          },
        },
      });

      // 2. Starting an autonomous run preserves the pre-run Away decision
      yield* metadata.update(scope, {
        action: "arc_run",
        arcRun: { op: "start", label: "First run" },
      });
      const afterStart = yield* projections.getThread(threadId);
      assert.strictEqual(afterStart.decisionLog?.length, 1);
      assert.strictEqual(afterStart.decisionLog?.[0]?.decision, "Keep existing config format");

      // 3. Log a second decision during the run and end it: both are returned
      yield* metadata.update(scope, {
        action: "arc_run",
        arcRun: {
          op: "decision",
          decision: {
            decision: "Use in-memory cache",
            alternative: "SQLite table",
            why: "Bounded to 100 entries",
            howToReverse: "Swap backing store",
          },
        },
      });
      const ended = yield* metadata.update(scope, {
        action: "arc_run",
        arcRun: { op: "end" },
      });
      assert.strictEqual(ended.decisionLog?.length, 2);

      // 4. Log a new pre-run Away decision after run 1 ended, then start run 2:
      // run 1's entries are dropped while the new pre-run decision is preserved
      yield* metadata.update(scope, {
        action: "arc_run",
        arcRun: {
          op: "decision",
          decision: {
            decision: "Skip optional benchmark",
            alternative: "Run full matrix",
            why: "No perf-sensitive paths touched",
            howToReverse: "Run benchmark command",
          },
        },
      });
      yield* metadata.update(scope, {
        action: "arc_run",
        arcRun: { op: "start", label: "Second run" },
      });
      const afterSecondStart = yield* projections.getThread(threadId);
      assert.strictEqual(afterSecondStart.decisionLog?.length, 1);
      assert.strictEqual(afterSecondStart.decisionLog?.[0]?.decision, "Skip optional benchmark");
    }).pipe(
      Effect.provide(
        ThreadMetadataMcp.layer.pipe(
          Layer.provideMerge(
            ThreadManagementService.layer.pipe(
              Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
            ),
          ),
          Layer.provideMerge(Layer.mock(ForgeWorkItems.ForgeWorkItems)({})),
          Layer.provideMerge(layerBase),
        ),
      ),
    ),
);

it.effect(
  "delegated Spec lead under global Away gets lead-safe Away turn note and continuation without op decision or op start",
  () =>
    Effect.gen(function* () {
      const leadNote = describeUnattendedTurnNote({
        thread: {
          lineage: { parentThreadId: ThreadId.make("thread:parent") },
          agentTask: { role: "lead" } as never,
        },
        away: true,
      });
      assert.include(leadNote, "Global Away is on");
      assert.include(leadNote, "close-out report");
      assert.notInclude(leadNote, "op decision");
      assert.notInclude(leadNote, "op start");

      const topLevelNote = describeUnattendedTurnNote({
        thread: {
          lineage: { parentThreadId: null },
        },
        away: true,
      });
      assert.include(topLevelNote, "op decision");
      assert.include(topLevelNote, "op start");

      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const unattended = yield* UnattendedReactor.UnattendedReactor;

      const parentId = yield* createThread("away-lead-parent", "Parent");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("cmd:msg:alp1"),
        threadId: parentId,
        messageId: MessageId.make("msg:alp1"),
        text: "Launch lead",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const parentRun = (yield* projections.getThreadRecords(parentId, ["runs"])).runs[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate:away-lead-child"),
        parentThreadId: parentId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: "Lead Spec",
        completionWake: "always",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        agentTask: {
          role: "lead",
          taskClass: "non-ui",
          workId: "work:away-lead",
          attemptId: "attempt-1",
          workspacePath: "/tmp/away-lead",
          executionRequirement: "trusted-host-allowed",
          readOnly: false,
          executionBoundary: "trusted-host-access",
          requestFingerprint: "a".repeat(64),
          policyHash: "b".repeat(64),
          policyRevision: "1",
          briefHash: "c".repeat(64),
          sourceAccess: "scoped-write",
          toolProfile: "implementation",
          requested: { instanceId, model: "gpt-5.1-codex", options: [] },
          assigned: null,
          effective: { instanceId, model: "gpt-5.1-codex", options: [] },
        },
        createdBy: "agent",
        creationSource: "mcp",
      });
      const { subagents } = yield* projections.getThreadRecords(parentId, ["subagents"]);
      const leadId = subagents.find((c) => c.childThreadId !== null)!.childThreadId!;
      const leadRun = (yield* projections.getThreadRecords(leadId, ["runs"])).runs[0]!;
      const now = yield* DateTime.now;
      const completedEvt = {
        id: EventId.make("event:away-lead:done"),
        type: "run.updated",
        threadId: leadId,
        runId: leadRun.id,
        occurredAt: now,
        payload: { ...leadRun, status: "completed", completedAt: now },
      } satisfies Extract<OrchestrationV2DomainEvent, { type: "run.updated" }>;
      yield* sink.write({ events: [completedEvt] });
      yield* unattended.setAway(true);
      yield* unattended.handle(completedEvt);

      const leadMsgs = (yield* projections.getThreadRecords(leadId, ["messages"])).messages;
      const cont = leadMsgs.find((m) => m.id.startsWith(UNATTENDED_CONTINUATION_MESSAGE_PREFIX));
      assert.isDefined(cont);
      assert.include(cont!.text, "close-out report");
      assert.notInclude(cont!.text, "op decision");
      assert.notInclude(cont!.text, "op start");
    }).pipe(Effect.provide(layerTest)),
);
