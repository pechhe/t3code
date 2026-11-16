import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
// Holds model-selection planning until both racing commands have read no receipt.
let capabilityGate: Effect.Effect<void> | undefined;
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () =>
    (capabilityGate ?? Effect.void).pipe(Effect.as(CodexProviderCapabilitiesV2)),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProjectionMaintenance.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "receipt-race" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("a command id reused concurrently for two threads succeeds for only one", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadIds = [ThreadId.make("thread:race-a"), ThreadId.make("thread:race-b")];
    for (const threadId of threadIds) {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:receipt-race"),
        title: threadId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }

    const arrived = yield* Ref.make(0);
    const bothArrived = yield* Deferred.make<void>();
    capabilityGate = Effect.gen(function* () {
      if ((yield* Ref.updateAndGet(arrived, (count) => count + 1)) === 2) {
        yield* Deferred.succeed(bothArrived, undefined);
      }
      yield* Deferred.await(bothArrived);
    });
    const setModel = (threadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("command:shared"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-6" },
      });
    const exits = yield* Effect.forEach(threadIds, (threadId) => Effect.exit(setModel(threadId)), {
      concurrency: "unbounded",
    }).pipe(Effect.ensuring(Effect.sync(() => (capabilityGate = undefined))));

    const winner = exits.findIndex(Exit.isSuccess);
    const loser = exits.findIndex(Exit.isFailure);
    assert.isAtLeast(winner, 0);
    assert.isAtLeast(loser, 0);
    const winnerExit = exits[winner]!;
    const loserExit = exits[loser]!;
    assert.isTrue(Exit.isSuccess(winnerExit) && Exit.isFailure(loserExit));
    if (Exit.isFailure(loserExit)) {
      const error = Cause.findErrorOption(loserExit.cause);
      assert.isTrue(error._tag === "Some");
      if (error._tag === "Some") {
        assert.equal(error.value._tag, "OrchestratorCommandIdConflictError");
        if (error.value._tag === "OrchestratorCommandIdConflictError") {
          assert.equal(error.value.receiptThreadId, threadIds[winner]);
          assert.equal(error.value.commandThreadId, threadIds[loser]);
        }
      }
    }

    const models = yield* Effect.forEach(threadIds, (threadId) =>
      projections.getThreadShell(threadId).pipe(Effect.map((shell) => shell?.modelSelection.model)),
    );
    assert.equal(models[winner], "gpt-6");
    assert.equal(models[loser], "gpt-5.1-codex");

    const noOpArrived = yield* Ref.make(0);
    const bothNoOpsArrived = yield* Deferred.make<void>();
    const getThreadRecords = projections.getThreadRecords;
    using _records = vi.spyOn(projections, "getThreadRecords").mockImplementation((...args) =>
      Effect.gen(function* () {
        if ((yield* Ref.updateAndGet(noOpArrived, (count) => count + 1)) === 2) {
          yield* Deferred.succeed(bothNoOpsArrived, undefined);
        }
        yield* Deferred.await(bothNoOpsArrived);
        return yield* getThreadRecords(...args);
      }),
    );
    const closeShare = (threadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.guest-share.close",
        commandId: CommandId.make("command:shared-noop"),
        threadId,
      });
    const noOpExits = yield* Effect.forEach(
      threadIds,
      (threadId) => Effect.exit(closeShare(threadId)),
      {
        concurrency: "unbounded",
      },
    );
    const noOpWinner = noOpExits.findIndex(Exit.isSuccess);
    const noOpLoser = noOpExits.findIndex(Exit.isFailure);
    assert.isAtLeast(noOpWinner, 0);
    assert.isAtLeast(noOpLoser, 0);
    const noOpFailure = noOpExits[noOpLoser]!;
    if (Exit.isFailure(noOpFailure)) {
      const error = Cause.findErrorOption(noOpFailure.cause);
      assert.isTrue(error._tag === "Some");
      if (error._tag === "Some") {
        assert.equal(error.value._tag, "OrchestratorCommandIdConflictError");
      }
    }
    const noOpReplay = yield* closeShare(threadIds[noOpWinner]!);
    const noOpSuccess = noOpExits[noOpWinner]!;
    if (Exit.isSuccess(noOpSuccess)) {
      assert.equal(noOpReplay.sequence, noOpSuccess.value.sequence);
      assert.deepEqual(noOpReplay.storedEvents, []);
    }

    // The winner's own thread still replays its receipt.
    const replay = yield* setModel(threadIds[winner]!);
    if (Exit.isSuccess(winnerExit)) {
      assert.equal(replay.sequence, winnerExit.value.sequence);
      assert.isAbove(replay.storedEvents.length, 0);
      assert.deepEqual(
        replay.storedEvents.map((stored) => stored.sequence),
        winnerExit.value.storedEvents.map((stored) => stored.sequence),
      );
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a retry after its thread's detail expired is refused, not answered empty", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const setTitle = (threadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`title:${threadId}`),
        threadId,
        title: "Renamed",
      });
    const original = new Map<ThreadId, ReadonlyArray<unknown>>();
    // Settled 15 days before the pass, and 5 days before it.
    for (const [threadId, settledDaysAgo] of [
      [ThreadId.make("thread:retry-expired"), 15],
      [ThreadId.make("thread:retry-kept"), 5],
    ] as const) {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:receipt-race"),
        title: threadId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      original.set(threadId, (yield* setTitle(threadId)).storedEvents);
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`settle:${threadId}`),
        threadId,
        settledAt: DateTime.subtract(now, { days: settledDaysAgo }),
      });
    }
    yield* maintenance.expireThreadDetail({ now, afterDays: 14 });

    const kept = yield* setTitle(ThreadId.make("thread:retry-kept"));
    assert.isTrue(kept.replayed);
    assert.deepStrictEqual(kept.storedEvents, original.get(ThreadId.make("thread:retry-kept")));
    const refused = yield* Effect.flip(setTitle(ThreadId.make("thread:retry-expired")));
    assert.equal(refused._tag, "OrchestratorCommandReplayExpiredError");
    assert.include(refused.message, "detail expired on");
    // Expiry keeps `thread.created`, so a retried create would otherwise replay part of its answer.
    const recreate = yield* Effect.flip(
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:thread:retry-expired"),
        threadId: ThreadId.make("thread:retry-expired"),
        projectId: ProjectId.make("project:receipt-race"),
        title: "thread:retry-expired",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      }),
    );
    assert.equal(recreate._tag, "OrchestratorCommandReplayExpiredError");
  }).pipe(Effect.provide(layerTest)),
);
