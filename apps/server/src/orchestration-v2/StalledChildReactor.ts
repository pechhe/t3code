import { CommandId, type OrchestrationV2ThreadStalled, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { decideStalledThreads, type StalledChildCandidate } from "./stalledChildren.ts";

const SWEEP_INTERVAL = "1 minute";
const MAX_LINEAGE_DEPTH = 16;
// A tool call or request waiting on a person or a command is not judged by silence.
const WAITS_ON_NOBODY = new Set(["dynamic_tool_call", "auth_refresh"]);

export class StalledChildReactor extends Context.Service<
  StalledChildReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/StalledChildReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* SecureRandom.SecureRandom;
  const serial = yield* Semaphore.make(1);
  // The marks are durable on the threads; the first pass after a restart finds them there.
  const marked = new Set<ThreadId>();
  let scannedMarks = false;

  const topLevelOf = Effect.fnUntraced(function* (parentId: ThreadId) {
    let current = parentId;
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
      const thread = yield* projections.getThread(current);
      const { parentThreadId, relationshipToParent } = thread.lineage;
      if (relationshipToParent !== "subagent" || parentThreadId === null) return thread;
      current = parentThreadId;
    }
    return undefined;
  });

  // Provider events are the thread's events written without a command: every server write, this
  // reactor's own included, carries one.
  const lastProviderEventAt = Effect.fnUntraced(function* (threadId: ThreadId) {
    const rows = yield* sql<{ readonly occurred_at: string }>`
      SELECT occurred_at FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId} AND command_id IS NULL
      ORDER BY sequence DESC LIMIT 1`;
    return rows[0] === undefined ? 0 : Date.parse(rows[0].occurred_at);
  });

  const candidates = Effect.fnUntraced(function* () {
    const runs = yield* sql<{
      readonly thread_id: string;
      readonly started_at: string | null;
      readonly requested_at: string;
      readonly parent_id: string | null;
      readonly title: string;
    }>`
      SELECT run.thread_id, json_extract(run.payload_json, '$.startedAt') AS started_at, run.requested_at,
        json_extract(thread.payload_json, '$.lineage.parentThreadId') AS parent_id,
        json_extract(thread.payload_json, '$.title') AS title
      FROM orchestration_v2_projection_runs AS run
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = run.thread_id
      WHERE run.status = 'running' AND thread.deleted_at IS NULL
        AND json_extract(thread.payload_json, '$.lineage.relationshipToParent') = 'subagent'`;
    const found: Array<StalledChildCandidate> = [];
    for (const run of runs) {
      if (run.parent_id === null) continue;
      const childThreadId = ThreadId.make(run.thread_id);
      const child = yield* projections.getThreadRecords(
        childThreadId,
        ["subagents", "runtimeRequests", "turnItems"],
        {
          turnItemTypes: ["command_execution"],
          turnItemStatuses: ["pending", "running", "waiting"],
        },
      );
      if (
        child.runtimeRequests.some(
          (request) => request.status === "pending" && !WAITS_ON_NOBODY.has(request.kind),
        ) ||
        // Its own delegated child is the one to judge, and an awaited command is not judged by silence.
        child.turnItems.length > 0 ||
        child.subagents.some(
          (task) =>
            task.origin === "app_owned" &&
            (task.status === "pending" || task.status === "running" || task.status === "waiting"),
        )
      ) {
        continue;
      }
      const topLevel = yield* topLevelOf(ThreadId.make(run.parent_id));
      if (topLevel === undefined) continue;
      found.push({
        topLevelThreadId: topLevel.id,
        childThreadId,
        title: run.title,
        lastProviderActivityAt: Math.max(
          Date.parse(run.started_at ?? run.requested_at),
          yield* lastProviderEventAt(childThreadId),
        ),
      });
    }
    return found;
  });

  const setMark = Effect.fnUntraced(function* (
    threadId: ThreadId,
    stalled: OrchestrationV2ThreadStalled | undefined,
  ) {
    yield* engine.dispatch({
      type: "thread.stalled.set",
      commandId: CommandId.make(`server:stalled:${threadId}:${yield* crypto.uuidV4()}`),
      threadId,
      ...(stalled === undefined ? {} : { stalled }),
    });
  });

  const sweep = serial.withPermits(1)(
    Effect.gen(function* () {
      if (!scannedMarks) {
        const rows = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NULL AND json_type(payload_json, '$.stalled') = 'object'`;
        for (const row of rows) marked.add(ThreadId.make(row.thread_id));
        scannedMarks = true;
      }
      const now = yield* Clock.currentTimeMillis;
      const stalled = decideStalledThreads(now, yield* candidates());
      for (const [threadId, mark] of stalled) {
        yield* setMark(threadId, mark).pipe(
          Effect.tap(() => Effect.sync(() => marked.add(threadId))),
          Effect.catchCause((cause) =>
            Effect.logWarning("Stalled mark failed", { threadId, cause }),
          ),
        );
      }
      for (const threadId of marked) {
        if (stalled.has(threadId)) continue;
        yield* setMark(threadId, undefined).pipe(
          Effect.tap(() => Effect.sync(() => marked.delete(threadId))),
          Effect.catchCause((cause) =>
            Effect.logWarning("Stalled clear failed", { threadId, cause }),
          ),
        );
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Stalled child sweep failed", { cause })),
    ),
  );

  return StalledChildReactor.of({
    sweep,
    start: Effect.fn("StalledChildReactor.start")(() =>
      forkParked(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid)).pipe(
        Effect.asVoid,
      ),
    ),
  });
});

export const layer = Layer.effect(StalledChildReactor, make);
