import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ForgeWorkItems from "../weave/ForgeWorkItems.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { ARC_RUN_UNREADABLE_WATCH_MS } from "./arcRun.ts";
import { threadsWithWaits } from "./parkedWait.ts";
import {
  buildWatchWaitsOnPerson,
  decideBuildWatch,
  sameWaitsOnPerson,
  threadWatchRefusal,
} from "./threadWatch.ts";

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
  const crypto = yield* SecureRandom.SecureRandom;
  const serial = yield* Semaphore.make(1);
  // In memory on purpose: a restart starts the clock again rather than blaming Forge for downtime.
  const unreadableSince = new Map<string, number>();

  // Rebuild from durable watches every pass, including the first pass after a restart.
  // ForgeWorkItems shares its summary cache across all watchers and client reads.
  const sweep = serial.withPermits(1)(
    Effect.gen(function* () {
      const rows = yield* threadsWithWaits(sql);
      for (const row of rows) {
        yield* Effect.gen(function* () {
          const thread = yield* projections.getThread(ThreadId.make(row.thread_id));
          // A parked wait survives settling; a held watch does not.
          const watches = [
            ...(threadWatchRefusal(thread) === undefined ? (thread.threadWatches ?? []) : []),
            ...(threadWatchRefusal(thread, undefined, { parked: true }) === undefined
              ? (thread.parkedWaits ?? [])
              : []),
          ].filter((watch) => watch.target.kind === "build_item");
          if (watches.length === 0) return;
          const parkedIds = new Set((thread.parkedWaits ?? []).map((wait) => wait.id));
          // A parked wait never fires on an unreadable item: it records what it saw and gives up.
          const recordLastKnown = Effect.fn("ForgeWatchReactor.recordLastKnown")(function* (
            watchId: string,
            lastKnown: string,
          ) {
            const wait = thread.parkedWaits?.find((candidate) => candidate.id === watchId);
            if (wait === undefined || wait.lastKnown === lastKnown) return;
            yield* engine.dispatch({
              type: "thread.thread-watch.fire",
              commandId: CommandId.make(`server:build-watch-known:${yield* crypto.uuidV4()}`),
              threadId: thread.id,
              watchId,
              lastKnown,
            });
          });
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
            if (cached === undefined || cached.unavailable || cached.item === null) {
              if (parkedIds.has(watch.id)) {
                yield* recordLastKnown(watch.id, `T3 could not read Build #${number} from Weave.`);
                continue;
              }
              const since = unreadableSince.get(watch.id) ?? passStartedAt;
              unreadableSince.set(watch.id, since);
              // The thread counts this watch as a wait, and it may never fire.
              if (passStartedAt - since > ARC_RUN_UNREADABLE_WATCH_MS) {
                unreadableSince.delete(watch.id);
                yield* engine.dispatch({
                  type: "thread.thread-watch.fire",
                  commandId: CommandId.make(`server:build-watch-fire:${yield* crypto.uuidV4()}`),
                  threadId: thread.id,
                  watchId: watch.id,
                  build: {
                    number,
                    title: watch.title,
                    url: `#${number}`,
                    condition: "unreadable",
                  },
                });
              }
              continue;
            }
            unreadableSince.delete(watch.id);
            if (
              parkedIds.has(watch.id) &&
              decideBuildWatch(watch.target, cached.item) === undefined
            ) {
              const item = cached.item;
              yield* recordLastKnown(
                watch.id,
                `Build ${item.ref ?? `#${number}`} was ${item.status}, with ${item.waits.length} open waits and ${item.holds.length} holds.`,
              );
              continue;
            }
            const held = thread.threadWatches?.find((candidate) => candidate.id === watch.id);
            const need =
              held === undefined ? undefined : buildWatchWaitsOnPerson(watch.target, cached.item);
            const waitsOnPerson =
              need === undefined
                ? undefined
                : {
                    need,
                    ...(cached.item.ref == null ? {} : { ref: cached.item.ref }),
                    ...(cached.item.title.trim() === "" ? {} : { title: cached.item.title.trim() }),
                  };
            if (held !== undefined && !sameWaitsOnPerson(waitsOnPerson, held.waitsOnPerson)) {
              yield* engine.dispatch({
                type: "thread.thread-watch.waits-on-person",
                commandId: CommandId.make(
                  `server:build-watch-person:${watch.id}:${yield* crypto.uuidV4()}`,
                ),
                threadId: thread.id,
                watchId: watch.id,
                ...(waitsOnPerson === undefined ? {} : { waitsOnPerson }),
              });
            }
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
              commandId: CommandId.make(`server:build-watch-fire:${yield* crypto.uuidV4()}`),
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
    start: Effect.fn("ForgeWatchReactor.start")(() =>
      forkParked(
        sweep.pipe(
          Effect.repeat(Schedule.spaced(`${ForgeWorkItems.BUILD_REREAD_INTERVAL_MS} millis`)),
          Effect.asVoid,
        ),
      ).pipe(Effect.asVoid),
    ),
  });
});

export const layer = Layer.effect(ForgeWatchReactor, make);
