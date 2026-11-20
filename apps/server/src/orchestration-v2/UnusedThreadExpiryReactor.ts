import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";

/** How long a thread a client launched may sit without a message before it is deleted. */
const UNUSED_THREAD_IDLE = Duration.minutes(30);

export class UnusedThreadExpiryReactor extends Context.Service<
  UnusedThreadExpiryReactor,
  {
    readonly sweep: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration-v2/UnusedThreadExpiryReactor") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* Orchestrator.OrchestratorV2;
  // A client launches a thread when its draft's project is chosen, before any message; one left
  // behind (a closed tab) would hold its workspace. Deleting it gives the workspace back. Forks
  // and side chats start empty beside a parent, so only top-level threads expire.
  const sweep = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const cutoff = DateTime.formatIso(DateTime.subtractDuration(now, UNUSED_THREAD_IDLE));
    const rows = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM orchestration_v2_projection_threads AS thread
      WHERE deleted_at IS NULL AND archived_at IS NULL AND updated_at < ${cutoff}
      AND json_extract(payload_json, '$.creationSource') IN ('web', 'mobile')
      AND json_extract(payload_json, '$.lineage.parentThreadId') IS NULL
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id = thread.thread_id)
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages WHERE thread_id = thread.thread_id)`;
    for (const row of rows) {
      // Rechecked under the thread's lock, so a message sent meanwhile keeps the thread.
      yield* engine.dispatch({
        type: "thread.delete",
        threadId: ThreadId.make(row.thread_id),
        commandId: CommandId.make(`unused-thread-expiry:${row.thread_id}`),
        onlyIfUnused: true,
      });
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Expiring unused threads failed", { cause })),
  );
  return {
    sweep,
    start: () => forkParked(sweep.pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.asVoid)),
  };
});
export const layer = Layer.effect(UnusedThreadExpiryReactor, make);
