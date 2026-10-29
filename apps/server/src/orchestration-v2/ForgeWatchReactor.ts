import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ForgeWorkItems from "../hq/ForgeWorkItems.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { decideBuildWatch, threadWatchRefusal } from "./threadWatch.ts";

export class ForgeWatchReactor extends Context.Service<
  ForgeWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ForgeWatchReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const build = yield* ForgeWorkItems.ForgeWorkItems;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const serial = yield* Semaphore.make(1);

  // Rebuild from durable watches every pass, including the first pass after a restart.
  // ForgeWorkItems shares its summary cache across all watchers and client reads.
  const sweep = serial.withPermits(1)(
    Effect.gen(function* () {
      const rows = yield* sql<{ thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
          INDEXED BY orchestration_v2_projection_threads_watching_idx
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
          const passStartedAt = yield* Clock.currentTimeMillis;
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
            const cached = result.items.find((item) => item.number === number);
            if (cached === undefined || cached.unavailable || cached.item === null) continue;
            if (decideBuildWatch(watch.target, cached.item) === undefined) continue;
            // A cached answer can predate a hold or wait opened outside T3's own connection: wake only
            // on an answer read in this pass.
            const readThisPass =
              cached.readAt !== null && Date.parse(cached.readAt) >= passStartedAt;
            const view = readThisPass
              ? cached
              : (yield* build.mentions(
                  { threadId: thread.id, numbers: [number] },
                  { fresh: true },
                )).items.find((item) => item.number === number);
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
                ...(view.item.ref == null ? {} : { ref: view.item.ref }),
                title: view.item.title.trim() || `Forge ${view.item.ref ?? `#${number}`}`,
                url: view.url,
                condition,
              },
            });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Forge watch check failed", { threadId: row.thread_id, cause }),
          ),
        );
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Forge watch sweep failed", { cause }))),
  );

  return ForgeWatchReactor.of({
    sweep,
    start: () =>
      forkParked(
        sweep.pipe(
          Effect.repeat(Schedule.spaced(`${ForgeWorkItems.BUILD_REREAD_INTERVAL_MS} millis`)),
          Effect.asVoid,
        ),
      ).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(ForgeWatchReactor, make);
