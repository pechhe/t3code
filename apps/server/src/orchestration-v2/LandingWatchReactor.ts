import * as NodeOS from "node:os";

import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadWatch,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SlipJayLandings from "../project/SlipJayLandings.ts";
import { submittingWorkspace, type TrackedLanding } from "../project/slipJayLandingState.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { threadWatchRefusal } from "./threadWatch.ts";

/** Events catch nearly every change; the sweep catches a landing that finished while the server was down. */
const SWEEP_MINUTES = 1;
/** A watch whose landing the runner no longer tracks (superseded, or past its retained ledger) ends silently. */
const STALE_WATCH_HOURS = 6;

export class LandingWatchReactor extends Context.Service<
  LandingWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/LandingWatchReactor") {}

const isActive = (landing: TrackedLanding) => landing.status === "active";

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const slipJay = yield* SlipJayLandings.SlipJayLandings;
  const sql = yield* SqlClient.SqlClient;
  const serial = yield* Semaphore.make(1);
  const host = NodeOS.hostname();
  /** Landings already resolved to a thread, or to none, so a landing is looked up once. */
  const resolved = new Set<string>();
  /** A checkout path in each repository, to ask SlipJay for that repository's workspaces. */
  const repositoryPaths = new Map<string, string>();

  const hintFor = Effect.fn("LandingWatchReactor.hintFor")(function* (repository: string) {
    const known = repositoryPaths.get(repository);
    if (known !== undefined) return known;
    const rows = yield* sql<{ path: string }>`
      SELECT DISTINCT json_extract(payload_json, '$.worktreePath') AS path
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND archived_at IS NULL
        AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
      ORDER BY updated_at DESC`;
    for (const { path } of rows) {
      if ((yield* slipJay.repositoryOf(path)) !== repository) continue;
      repositoryPaths.set(repository, path);
      return path;
    }
    return undefined;
  });

  // The workspace may be removed once it lands, so the thread is chosen while the landing is
  // active. Several threads holding one checkout are ambiguous: none is armed.
  const arm = Effect.fn("LandingWatchReactor.arm")(function* (landing: TrackedLanding) {
    if (landing.submittedBy === undefined || resolved.has(landing.operationId)) return;
    const name = submittingWorkspace(landing.submittedBy, host);
    if (name === undefined) {
      resolved.add(landing.operationId);
      return;
    }
    // No checkout can be a failed `slipjay list` or a removed hint path: look again next sweep.
    const hint = yield* hintFor(landing.repo);
    const root = hint === undefined ? undefined : yield* slipJay.workspaceRoot({ cwd: hint, name });
    if (root === undefined) {
      repositoryPaths.delete(landing.repo);
      return;
    }
    const rows = yield* sql<{ thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND archived_at IS NULL
        AND (
          json_extract(payload_json, '$.worktreePath') = ${root}
          OR EXISTS (
            SELECT 1 FROM json_each(payload_json, '$.workspaceAttachments')
            WHERE json_extract(value, '$.workspacePath') = ${root}
          )
        )`;
    const threads = [];
    for (const row of rows) {
      const thread = yield* projections.getThread(ThreadId.make(row.thread_id));
      if (threadWatchRefusal(thread) === undefined) threads.push(thread);
    }
    const [thread] = threads;
    if (thread !== undefined && threads.length === 1) {
      yield* engine.dispatch({
        type: "thread.thread-watch",
        commandId: CommandId.make(`server:landing-watch:${landing.operationId}:${thread.id}`),
        threadId: thread.id,
        target: { kind: "landing", operationId: landing.operationId },
        title: landing.spec === undefined ? landing.repo : `Build #${landing.spec}`,
        watching: true,
      });
    }
    resolved.add(landing.operationId);
  });

  const settleWatch = Effect.fn("LandingWatchReactor.settleWatch")(function* (
    thread: OrchestrationV2AppThread,
    watch: OrchestrationV2ThreadWatch,
    landings: ReadonlyMap<string, TrackedLanding>,
  ) {
    if (watch.target.kind !== "landing") return;
    const { operationId } = watch.target;
    const landing = landings.get(operationId);
    if (landing === undefined) {
      const now = yield* DateTime.now;
      const ageHours =
        (DateTime.toEpochMillis(now) - Date.parse(watch.startedAt)) / (60 * 60 * 1000);
      if (ageHours < STALE_WATCH_HOURS) return;
      yield* engine.dispatch({
        type: "thread.thread-watch",
        commandId: CommandId.make(`server:landing-watch-end:${watch.id}`),
        threadId: thread.id,
        target: watch.target,
        watching: false,
      });
      return;
    }
    if (isActive(landing)) return;
    yield* engine.dispatch({
      type: "thread.thread-watch.fire",
      commandId: CommandId.make(`server:landing-watch-fire:${watch.id}`),
      threadId: thread.id,
      watchId: watch.id,
      landing: {
        operationId,
        outcome: landing.status === "active" ? "unknown" : landing.status,
        repository: landing.repo,
        stage: landing.stage,
        ...(landing.reason === undefined ? {} : { reason: landing.reason }),
        ...(landing.commitId === undefined ? {} : { commitId: landing.commitId }),
        ...(landing.spec === undefined ? {} : { spec: landing.spec }),
      },
    });
  });

  // One watch that cannot be settled never holds back the others.
  const settle = Effect.fn("LandingWatchReactor.settle")(function* (
    landings: ReadonlyMap<string, TrackedLanding>,
  ) {
    const rows = yield* sql<{ thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads
        INDEXED BY orchestration_v2_projection_threads_watching_idx
      WHERE deleted_at IS NULL
        AND json_array_length(payload_json, '$.threadWatches') > 0`;
    for (const row of rows) {
      const thread = yield* projections.getThread(ThreadId.make(row.thread_id));
      for (const watch of thread.threadWatches ?? []) {
        yield* settleWatch(thread, watch, landings).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("landing watch could not be settled", {
              threadId: thread.id,
              watchId: watch.id,
              cause,
            }),
          ),
        );
      }
    }
  });

  const sweep = serial.withPermits(1)(
    Effect.gen(function* () {
      const landings = yield* slipJay.landings;
      yield* Effect.forEach(
        landings.filter(isActive),
        (landing) =>
          arm(landing).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("landing watch could not be armed", {
                operationId: landing.operationId,
                cause,
              }),
            ),
          ),
        { discard: true },
      );
      yield* settle(new Map(landings.map((landing) => [landing.operationId, landing])));
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("landing watch sweep failed", { cause })),
    ),
  );

  return LandingWatchReactor.of({
    sweep,
    start: Effect.fn("LandingWatchReactor.start")(function* () {
      yield* forkParked(slipJay.follow);
      yield* forkParked(Stream.runForEach(slipJay.changes, () => sweep));
      yield* forkParked(
        sweep.pipe(Effect.repeat(Schedule.spaced(`${SWEEP_MINUTES} minutes`)), Effect.asVoid),
      );
    }),
  });
});

export const layer = Layer.effect(LandingWatchReactor, make);
