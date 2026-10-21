import { assert, it } from "@effect/vitest";
import {
  CommandId,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "compact-at" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const createThread = Effect.fn("createThread")(function* (id: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(id);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-${id}`),
    threadId,
    projectId: ProjectId.make("project:compact-at"),
    title: "Compact",
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

it.effect(
  "sets and clears a thread's compact-at point, projected to thread, shell and column",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* createThread("thread:compact-at");
      const column = () =>
        sql<{ readonly compactAt: number | null }>`
        SELECT compact_at AS compactAt FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId}`;

      assert.isUndefined(
        (yield* projections.getThreadProjection(threadId)).thread.compactAt ?? undefined,
      );
      yield* orchestrator.dispatch({
        type: "thread.compact-at.set",
        commandId: CommandId.make("compact-at-set"),
        threadId,
        compactAt: 150_000,
      });
      assert.equal((yield* projections.getThreadProjection(threadId)).thread.compactAt, 150_000);
      assert.equal((yield* projections.getThreadShell(threadId))?.compactAt, 150_000);
      assert.deepEqual(yield* column(), [{ compactAt: 150_000 }]);

      yield* orchestrator.dispatch({
        type: "thread.compact-at.set",
        commandId: CommandId.make("compact-at-clear"),
        threadId,
        compactAt: null,
      });
      assert.isNull((yield* projections.getThreadProjection(threadId)).thread.compactAt ?? null);
      assert.deepEqual(yield* column(), [{ compactAt: null }]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("still decodes and projects the rollover events already stored", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* createThread("thread:compact-at-legacy");
    const thread = (yield* projections.getThreadProjection(threadId)).thread;
    const encodedThread = yield* Schema.encodeEffect(OrchestrationV2AppThread)(thread);
    const decodeEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEvent);
    for (const type of ["thread.rollover-hold-set", "thread.rollover-thresholds-set"] as const) {
      const event = yield* decodeEvent({
        id: `event:${type}`,
        threadId,
        type,
        occurredAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
        // The thread as stored then, with the fields rollover wrote.
        payload: {
          ...encodedThread,
          rolloverHold: { kind: "off" },
          rolloverThresholds: { soft: 150_000, hard: 180_000 },
        },
      });
      assert.equal(event.type, type);
      assert.equal((event.payload as { id: string }).id, threadId);
    }
  }).pipe(Effect.provide(layerTest)),
);
