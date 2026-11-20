import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);

const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);

const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ingestor-git-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerEmptyInstances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
  getInstance: () => Effect.undefined,
});
const makeLayerTest = <E>(
  ingestorEventSink: Layer.Layer<EventSink.EventSinkV2, E>,
  instances = layerEmptyInstances,
) =>
  Layer.mergeAll(
    instances,
    layerTestDatabase,
    layerTestStores,
    layerTestEventSink,
    IdAllocator.layer,
    ThreadCommandExecutor.layer,
    layerGit,
    ProviderEventIngestor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          instances,
          layerTestStores,
          ingestorEventSink,
          IdAllocator.layer,
          ThreadCommandExecutor.layer,
          layerGit,
        ),
      ),
    ),
  );
const layerTest = makeLayerTest(layerTestEventSink);

/** The ingestor's next sink writes of `events` fail with `errors`, in order; the rest go through. */
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");
function threadCreatedEvent(
  now: DateTime.Utc,
): Effect.Effect<
  OrchestrationV2DomainEvent,
  IdAllocator.IdAllocatorV2Error,
  IdAllocator.IdAllocatorV2
> {
  return Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({
      fixtureName: "provider-event-ingestor",
    });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName: "provider-event-ingestor",
      projectId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Provider event ingestor",
      providerInstanceId: modelSelection.instanceId,
      modelSelection: modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      branchPullRequest: null,
      activeOrderKey: null,
      activeProviderThreadId: providerThreadId,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };

    return {
      id: yield* idAllocator.allocate.event({ threadId }),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    };
  });
}

const layer = it.layer(layerTest);

layer("ProviderEventIngestorV2", (it) => {
  it.effect(
    "mirrors a child's context tokens onto its subagent and keeps them across updates",
    () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const rootEvent = yield* threadCreatedEvent(now);
        if (rootEvent.type !== "thread.created") {
          throw new Error("Expected a thread.created fixture event");
        }
        const childThreadId = idAllocator.derive.threadFromProviderThread({
          driver: CODEX_DRIVER,
          nativeThreadId: "native-token-subagent",
        });
        const providerThreadId = idAllocator.derive.providerThread({
          driver: CODEX_DRIVER,
          nativeThreadId: "native-token-subagent",
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: rootEvent.threadId,
        });
        const ingest = (event: ProviderEventIngestor.ProviderEventIngestInput["event"]) =>
          ingestor.ingestNormalized({
            providerSessionId,
            providerInstanceId: modelSelection.instanceId,
            threadId: rootEvent.threadId,
            event,
          });
        yield* eventSink.write({ events: [rootEvent] });
        yield* ingest({
          type: "app_thread.created",
          driver: CODEX_DRIVER,
          appThread: {
            ...rootEvent.payload,
            id: childThreadId,
            title: "count tokens",
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: rootEvent.threadId,
              relationshipToParent: "subagent",
              rootThreadId: rootEvent.threadId,
            },
          },
        });
        const subagentUpdated = {
          type: "subagent.updated",
          driver: CODEX_DRIVER,
          subagent: {
            id: NodeId.make("node:token-subagent"),
            threadId: rootEvent.threadId,
            runId: null,
            parentNodeId: NodeId.make("node:root"),
            origin: "provider_native",
            createdBy: "agent",
            driver: CODEX_DRIVER,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId,
            nativeTaskRef: null,
            prompt: "Count tokens",
            title: "count tokens",
            model: "gpt-6.1-sol",
            status: "running",
            result: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
          },
        } satisfies ProviderEventIngestor.ProviderEventIngestInput["event"];
        yield* ingest(subagentUpdated);
        const reportUsage = (usedTokens: number) =>
          ingest({
            type: "provider_turn.updated",
            driver: CODEX_DRIVER,
            threadId: childThreadId,
            providerTurn: {
              id: idAllocator.derive.providerTurn({
                driver: CODEX_DRIVER,
                nativeTurnId: "token-subagent-turn",
              }),
              providerThreadId,
              nodeId: NodeId.make("node:token-subagent-turn"),
              runAttemptId: null,
              nativeTurnRef: null,
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
              tokenUsage: { usedTokens, updatedAt: now.toString() },
            },
          });
        const storedTokens = () =>
          projectionStore
            .getSubagentByChildThread(childThreadId)
            .pipe(Effect.map((subagent) => subagent?.totalTokens));

        const first = yield* reportUsage(61_000);
        assert.deepEqual(
          first.map((stored) => stored.event.type),
          ["provider-turn.updated", "subagent.updated"],
        );
        assert.equal(yield* storedTokens(), 61_000);

        // An unchanged report writes nothing more.
        const repeated = yield* reportUsage(61_000);
        assert.deepEqual(
          repeated.map((stored) => stored.event.type),
          ["provider-turn.updated"],
        );

        // The adapter re-sends the subagent without usage; the mirrored total survives.
        yield* ingest({
          ...subagentUpdated,
          subagent: { ...subagentUpdated.subagent, status: "completed", completedAt: now },
        });
        assert.equal(yield* storedTokens(), 61_000);
      }),
  );
});
