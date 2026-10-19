import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as BuildWorkItems from "../hq/BuildWorkItems.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { decideBuildWatch, threadWatchRefusal } from "./threadWatch.ts";

export class BuildWatchReactor extends Context.Service<
  BuildWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/BuildWatchReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const build = yield* BuildWorkItems.BuildWorkItems;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const serial = yield* Semaphore.make(1);

  // Rebuild from durable watches every pass, including the first pass after a restart.
  // BuildWorkItems shares its summary cache across all watchers and client reads.
  const sweep = serial.withPermits(1)(
    Effect.gen(function* () {
      const rows = yield* sql<{ thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL
          AND json_array_length(payload_json, '$.threadWatches') > 0`;
      for (const row of rows) {
        yield* Effect.gen(function* () {
          const thread = yield* projections.getThread(ThreadId.make(row.thread_id));
          if (threadWatchRefusal(thread) !== undefined) return;
          const watches = (thread.threadWatches ?? []).filter(
            (watch) => watch.target.kind === "build_item",
          );
          if (watches.length === 0) return;
          const result = yield* build.mentions({
            threadId: thread.id,
            numbers: watches.flatMap((watch) =>
              watch.target.kind === "build_item" ? [watch.target.number] : [],
            ),
          });
          // `unavailable` means some number could not be resolved; the ones that did still count.
          for (const watch of watches) {
            if (watch.target.kind !== "build_item") continue;
            const number = watch.target.number;
            const view = result.items.find((item) => item.number === number);
            if (view === undefined || view.unavailable || view.item === null) continue;
            const condition = decideBuildWatch(watch.target, view.item);
            if (condition === undefined) continue;
            yield* engine.dispatch({
              type: "thread.thread-watch.fire",
              commandId: CommandId.make(`server:build-watch-fire:${yield* crypto.randomUUIDv4()}`),
              threadId: thread.id,
              watchId: watch.id,
              build: {
                number,
                title: view.item.title.trim() || `Build #${number}`,
                url: view.url,
                condition,
              },
            });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Build watch check failed", { threadId: row.thread_id, cause }),
          ),
        );
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Build watch sweep failed", { cause }))),
  );

  return BuildWatchReactor.of({
    sweep,
    start: () =>
      forkParked(
        sweep.pipe(
          Effect.repeat(Schedule.spaced(`${BuildWorkItems.BUILD_REREAD_INTERVAL_MS} millis`)),
          Effect.asVoid,
        ),
      ).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(BuildWatchReactor, make);
