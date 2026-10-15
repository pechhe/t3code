import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "./Sqlite.ts";
import * as Events from "./OrchestrationEventStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";

const layer = Layer.mergeAll(Events.layer, Projections.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
it.layer(layer)("legacy advisor source pins", (it) => {
  it.effect(
    "reads old event and projection pins under the new name without rewriting historical events",
    () =>
      Effect.gen(function* () {
        const events = yield* Events.OrchestrationEventStore;
        const projections = yield* Projections.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("legacy-advisor");
        const providerInstanceId = ProviderInstanceId.make("codex");
        const event: OrchestrationV2DomainEvent = {
          id: EventId.make("legacy-advisor-created"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "agent",
            creationSource: "mcp",
            id: threadId,
            projectId: ProjectId.make("legacy-advisor-project"),
            title: "Advisor",
            providerInstanceId,
            modelSelection: { instanceId: providerInstanceId, model: "test-model" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
            followupSourceRevision: "revision-B",
          },
        };
        yield* events.appendAgentEvents({ events: [event] });
        yield* projections.apply(event);
        yield* sql`UPDATE orchestration_events SET payload_json = json_set(json_remove(payload_json, '$.followupSourceRevision'), '$.advisorSourceRevision', 'revision-B') WHERE event_id = ${event.id}`;
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(json_remove(payload_json, '$.followupSourceRevision'), '$.advisorSourceRevision', 'revision-B') WHERE thread_id = ${threadId}`;
        expect((yield* projections.getThread(threadId)).followupSourceRevision).toBe("revision-B");
        expect((yield* projections.getThreadShell(threadId))?.followupSourceRevision).toBe(
          "revision-B",
        );
        const replayed = yield* events.readAgentEvents({ threadId }).pipe(Stream.runCollect);
        expect(replayed[0]?.event.payload).toMatchObject({ followupSourceRevision: "revision-B" });
        const [raw] = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE event_id = ${event.id}`;
        expect(JSON.parse(raw!.payload_json)).toMatchObject({
          advisorSourceRevision: "revision-B",
        });
        expect(JSON.parse(raw!.payload_json)).not.toHaveProperty("followupSourceRevision");
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.followupSourceRevision', 'revision-C') WHERE thread_id = ${threadId}`;
        expect((yield* projections.getThread(threadId)).followupSourceRevision).toBe("revision-C");
      }),
  );
});
