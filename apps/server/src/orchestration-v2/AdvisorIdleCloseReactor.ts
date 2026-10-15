import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";

export class AdvisorIdleCloseReactor extends Context.Service<
  AdvisorIdleCloseReactor,
  {
    readonly sweep: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration-v2/AdvisorIdleCloseReactor") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* Orchestrator.OrchestratorV2;
  const settings = yield* Settings.ServerSettingsService;
  const sweep = Effect.gen(function* () {
    if ((yield* settings.getSettings).delegation.advisorIdleCloseMinutes === null) return;
    // Only advisor thread rows, no conversation history. The command rechecks eligibility
    // under the same parent/child locks as follow-up intake.
    const rows = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND archived_at IS NULL
      AND json_extract(payload_json, '$.agentTask.role') = 'advisor'
      AND json_extract(payload_json, '$.advisorClosedAt') IS NULL`;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const row of rows) {
      yield* engine.dispatch({
        type: "advisor.idle.close",
        threadId: ThreadId.make(row.thread_id),
        commandId: CommandId.make(`advisor-idle-close:${row.thread_id}:${now}`),
      });
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Idle advisor closing failed", { cause })),
  );
  return {
    sweep,
    start: () => forkParked(sweep.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid)),
  };
});
export const layer = Layer.effect(AdvisorIdleCloseReactor, make);
