import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { isTerminalRunStatus } from "./ThreadManagementService.ts";

/** Catches a move whose chat went idle while the server was down. */
const SWEEP_MINUTES = 5;

/**
 * Makes the project moves agents record on their own No project chats. A move
 * waits until the chat has no active or queued run, so the moved chat carries
 * the turn that made it. Command ids derive from the move, so a retry after a
 * partial move replays the steps already taken.
 */
export class ProjectMoveReactor extends Context.Service<
  ProjectMoveReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ProjectMoveReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const serial = yield* Semaphore.make(1);

  const moveWhenIdle = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const { thread, runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      const suggestion = thread.projectSuggestion;
      const move = suggestion?.move;
      if (
        suggestion == null ||
        move == null ||
        suggestion.dismissedAt !== null ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        runs.some((run) => !isTerminalRunStatus(run.status))
      )
        return;
      const step = (name: string) =>
        CommandId.make(`server:project-move:${move.targetThreadId}:${name}`);
      yield* engine.dispatch({
        type: "thread.fork",
        commandId: step("fork"),
        sourceThreadId: threadId,
        targetThreadId: move.targetThreadId,
        sourcePoint: { type: "latest_finished" },
        title: thread.title,
        projectId: suggestion.projectId,
        moveWorkspaceAttachments: true,
        createdBy: "agent",
        creationSource: "server",
      });
      if (move.continuation !== null) {
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: step("continue"),
          threadId: move.targetThreadId,
          messageId: MessageId.make(`message:project-move:${move.targetThreadId}`),
          text: move.continuation,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
        });
      }
      yield* engine.dispatch({ type: "thread.archive", commandId: step("archive"), threadId });
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("project move failed", { threadId, cause })),
    );

  const handle: ProjectMoveReactor["Service"]["handle"] = (event) =>
    (event.type === "run.updated" && isTerminalRunStatus(event.payload.status)) ||
    (event.type === "thread.metadata-updated" && event.payload.projectSuggestion?.move != null)
      ? serial.withPermits(1)(moveWhenIdle(event.threadId))
      : Effect.void;

  const sweep = serial.withPermits(1)(
    Effect.gen(function* () {
      const rows = yield* sql<{ thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL AND archived_at IS NULL
          AND json_extract(payload_json, '$.projectSuggestion.move') IS NOT NULL`;
      yield* Effect.forEach(rows, (row) => moveWhenIdle(ThreadId.make(row.thread_id)), {
        discard: true,
      });
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("project move sweep failed", { cause })),
    ),
  );

  const start: ProjectMoveReactor["Service"]["start"] = () =>
    Effect.gen(function* () {
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, handle).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("project move event stream failed", { cause }),
          ),
        ),
      );
      yield* forkParked(
        sweep.pipe(Effect.repeat(Schedule.spaced(`${SWEEP_MINUTES} minutes`)), Effect.asVoid),
      );
    });

  return { start, handle, sweep } satisfies ProjectMoveReactor["Service"];
});

export const layer = Layer.effect(ProjectMoveReactor, make);
