import * as NodeOS from "node:os";

import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ParkedWait,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadWatch,
  type SlipJayRunnerOverview,
  ThreadId,
  isLeafSubagentThread,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { threadsWithWaits } from "./parkedWait.ts";
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
    /** Checks a Production wait as soon as it is parked, so one already served wakes at once. */
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/LandingWatchReactor") {}

const isActive = (landing: TrackedLanding) => landing.status === "active";

type ParkedFire = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.thread-watch.fire" }
>;

/** Only a commit id reaches git's argv, so no target can pose as an option. */
const COMMIT_ID = /^[0-9a-f]{7,64}$/i;

const landingPayload = (landing: TrackedLanding) => ({
  operationId: landing.operationId,
  outcome: landing.status === "active" ? ("unknown" as const) : landing.status,
  repository: landing.repo,
  stage: landing.stage,
  ...(landing.reason === undefined ? {} : { reason: landing.reason }),
  ...(landing.commitId === undefined ? {} : { commitId: landing.commitId }),
  ...(landing.spec === undefined ? {} : { spec: landing.spec }),
});

/** The commit Production serves in `repository`, as the runner last reported it. */
function productionServes(overview: SlipJayRunnerOverview, repository: string): string | undefined {
  return (
    overview.repositories.find((entry) => entry.repo === repository)?.release?.production.live
      ?.commitId ?? undefined
  );
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const slipJay = yield* SlipJayLandings.SlipJayLandings;
  const sql = yield* SqlClient.SqlClient;
  const vcs = yield* VcsProcess.VcsProcess;
  const crypto = yield* SecureRandom.SecureRandom;
  const serial = yield* Semaphore.make(1);
  /** A checkout fetches a commit it lacks once, not on every pass. */
  const fetched = new Set<string>();
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

  const watchFor = (landing: TrackedLanding, thread: OrchestrationV2AppThread) =>
    engine.dispatch({
      type: "thread.thread-watch",
      commandId: CommandId.make(`server:landing-watch:${landing.operationId}:${thread.id}`),
      threadId: thread.id,
      target: { kind: "landing", operationId: landing.operationId },
      title: landing.spec === undefined ? landing.repo : `Build #${landing.spec}`,
      watching: true,
    });

  // The thread whose own `slipjay land` printed the operation, from whichever workspace it ran:
  // a subagent's command belongs to the thread that owns it. The first command to show the id
  // submitted it; a later one only names it.
  const threadThatSubmitted = Effect.fn("LandingWatchReactor.threadThatSubmitted")(function* (
    landing: TrackedLanding,
  ) {
    const rows = yield* sql<{ thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_turn_items
        INDEXED BY orchestration_v2_projection_turn_items_slipjay_land_idx
      WHERE type = 'command_execution'
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.input') END
        LIKE '%slipjay%land%'
        AND instr(payload_json, ${landing.operationId}) > 0
      ORDER BY updated_at ASC`;
    for (const row of rows) {
      let thread = yield* projections.getThread(ThreadId.make(row.thread_id));
      for (
        let depth = 0;
        isLeafSubagentThread(thread) && thread.lineage.parentThreadId !== null && depth < 8;
        depth++
      ) {
        thread = yield* projections.getThread(thread.lineage.parentThreadId);
      }
      if (threadWatchRefusal(thread) === undefined && !isLeafSubagentThread(thread)) return thread;
    }
    return undefined;
  });

  // The workspace may be removed once it lands, so the thread is chosen while the landing is
  // active: the thread that ran `slipjay land`, else the one thread holding the submitting
  // checkout. Several threads holding one checkout are ambiguous: none is armed.
  const arm = Effect.fn("LandingWatchReactor.arm")(function* (landing: TrackedLanding) {
    if (landing.submittedBy === undefined || resolved.has(landing.operationId)) return;
    const submitter = yield* threadThatSubmitted(landing);
    if (submitter !== undefined) {
      yield* watchFor(landing, submitter);
      resolved.add(landing.operationId);
      return;
    }
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
      // A landing a child submitted wakes the thread that owns the child, as it always has.
      if (threadWatchRefusal(thread) === undefined && !isLeafSubagentThread(thread))
        threads.push(thread);
    }
    const [thread] = threads;
    if (thread !== undefined && threads.length === 1) yield* watchFor(landing, thread);
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
        commandId: CommandId.make(`server:landing-watch-end:${thread.id}:${watch.id}`),
        threadId: thread.id,
        target: watch.target,
        watching: false,
      });
      return;
    }
    if (isActive(landing)) return;
    // T3 arms landing watches only on non-leaf threads, so one on a leaf is a copy its parent's
    // watch left there; waking the child would cost a turn whose reply returns to the parent.
    if (isLeafSubagentThread(thread) && watch.id.startsWith("thread-watch:server:landing-watch:")) {
      yield* engine.dispatch({
        type: "thread.thread-watch",
        commandId: CommandId.make(`server:landing-watch-end:${thread.id}:${watch.id}`),
        threadId: thread.id,
        target: watch.target,
        watching: false,
      });
      return;
    }
    yield* engine.dispatch({
      type: "thread.thread-watch.fire",
      commandId: CommandId.make(`server:landing-watch-fire:${thread.id}:${watch.id}`),
      threadId: thread.id,
      watchId: watch.id,
      landing: landingPayload(landing),
    });
  });

  // A parked wait reports what T3 knows until it is met; it gives up on its own deadline.
  const reportParked = Effect.fn("LandingWatchReactor.reportParked")(function* (
    thread: OrchestrationV2AppThread,
    wait: OrchestrationV2ParkedWait,
    fire: Pick<ParkedFire, "lastKnown" | "landing" | "production">,
  ) {
    if (fire.lastKnown !== undefined && fire.lastKnown === wait.lastKnown) return;
    yield* engine.dispatch({
      type: "thread.thread-watch.fire",
      commandId: CommandId.make(`server:parked-wait-check:${thread.id}:${yield* crypto.uuidV4()}`),
      threadId: thread.id,
      watchId: wait.id,
      ...fire,
    });
  });

  const settleParkedLanding = Effect.fn("LandingWatchReactor.settleParkedLanding")(function* (
    thread: OrchestrationV2AppThread,
    wait: OrchestrationV2ParkedWait,
    landings: ReadonlyMap<string, TrackedLanding>,
  ) {
    if (wait.target.kind !== "landing") return;
    const { operationId } = wait.target;
    const landing = landings.get(operationId);
    if (landing === undefined) {
      return yield* reportParked(thread, wait, {
        lastKnown: `SlipJay's runner on this host does not track landing ${operationId}.`,
      });
    }
    if (isActive(landing)) {
      return yield* reportParked(thread, wait, {
        lastKnown: `Landing ${operationId} was still running, at ${landing.stage}.`,
      });
    }
    yield* reportParked(thread, wait, { landing: landingPayload(landing) });
  });

  const git = (cwd: string, args: ReadonlyArray<string>, timeoutMs = 30_000) =>
    vcs
      .run({
        operation: "LandingWatchReactor.production",
        command: "git",
        args,
        cwd,
        allowNonZeroExit: true,
        timeoutMs,
      })
      .pipe(
        Effect.map((output) => output.exitCode as number),
        Effect.orElseSucceed(() => -1),
      );

  /** Whether `served` is `commit` or descends from it; undefined when `cwd` cannot tell. */
  const includes = Effect.fn("LandingWatchReactor.includes")(function* (
    cwd: string,
    commit: string,
    served: string,
  ) {
    for (const id of [commit, served]) {
      const holds = git(cwd, ["cat-file", "-e", `${id}^{commit}`]).pipe(
        Effect.map((code) => code === 0),
      );
      if (yield* holds) continue;
      const key = `${cwd}\u0000${id}`;
      if (!fetched.has(key)) {
        // Only a fetch that ran cleanly is final: a transient failure is retried on a later pass.
        if ((yield* git(cwd, ["fetch", "--quiet", "origin", id], 120_000)) === 0) fetched.add(key);
      }
      if (!(yield* holds)) return undefined;
    }
    const code = yield* git(cwd, ["merge-base", "--is-ancestor", commit, served]);
    return code === 0 ? true : code === 1 ? false : undefined;
  });

  /** Checkouts of the wait's project: the thread's own, then the project's root. */
  const productionCheckouts = Effect.fn("LandingWatchReactor.productionCheckouts")(function* (
    thread: OrchestrationV2AppThread,
    projectId: string,
  ) {
    const rows = yield* sql<{ workspace_root: string }>`
      SELECT workspace_root FROM projection_projects
      WHERE project_id = ${projectId} AND deleted_at IS NULL`;
    return [
      ...new Set([
        ...(thread.projectId === projectId && thread.worktreePath !== null
          ? [thread.worktreePath]
          : []),
        ...rows.map((row) => row.workspace_root),
      ]),
    ];
  });

  const checkProduction = Effect.fn("LandingWatchReactor.checkProduction")(function* (
    thread: OrchestrationV2AppThread,
    wait: OrchestrationV2ParkedWait,
    overview: SlipJayRunnerOverview,
  ) {
    if (wait.target.kind !== "production") return;
    const { commitId } = wait.target;
    const checkouts = yield* productionCheckouts(thread, wait.target.projectId ?? thread.projectId);
    let repository: string | null = null;
    for (const checkout of checkouts) {
      repository = yield* slipJay.repositoryOf(checkout);
      if (repository !== null) break;
    }
    if (repository === null) {
      return yield* reportParked(thread, wait, {
        lastKnown: "T3 found no SlipJay checkout of this project, so it could not decide.",
      });
    }
    if (!overview.connected) {
      return yield* reportParked(thread, wait, {
        lastKnown: `T3 could not reach the SlipJay runner, so it could not decide whether Production in ${repository} serves ${commitId}.`,
      });
    }
    const served = productionServes(overview, repository);
    if (served === undefined) {
      return yield* reportParked(thread, wait, {
        lastKnown: `The SlipJay runner reported no live Production deploy for ${repository}.`,
      });
    }
    if (COMMIT_ID.test(commitId) && COMMIT_ID.test(served)) {
      for (const checkout of checkouts) {
        const decided = yield* includes(checkout, commitId, served);
        if (decided === true) {
          return yield* reportParked(thread, wait, {
            production: { repository, servedCommitId: served },
          });
        }
        if (decided === false) {
          return yield* reportParked(thread, wait, {
            lastKnown: `Production in ${repository} served ${served}, which does not include ${commitId}.`,
          });
        }
      }
    }
    yield* reportParked(thread, wait, {
      lastKnown: `Production in ${repository} served ${served}, but no checkout T3 knows holds both commits, so it could not decide.`,
    });
  });

  const currentOverview = Stream.runHead(slipJay.runner).pipe(
    Effect.map((head) => (head._tag === "Some" ? head.value : undefined)),
  );

  const settleParked = Effect.fn("LandingWatchReactor.settleParked")(function* (
    thread: OrchestrationV2AppThread,
    landings: ReadonlyMap<string, TrackedLanding> | undefined,
    overview: { current?: SlipJayRunnerOverview | undefined; read: boolean },
  ) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) return;
    for (const wait of thread.parkedWaits ?? []) {
      yield* Effect.gen(function* () {
        if (wait.target.kind === "landing" && landings !== undefined) {
          yield* settleParkedLanding(thread, wait, landings);
        } else if (wait.target.kind === "production") {
          if (!overview.read) {
            overview.current = yield* currentOverview;
            overview.read = true;
          }
          if (overview.current !== undefined)
            yield* checkProduction(thread, wait, overview.current);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("parked wait could not be checked", {
            threadId: thread.id,
            watchId: wait.id,
            cause,
          }),
        ),
      );
    }
  });

  // One watch that cannot be settled never holds back the others.
  const settle = Effect.fn("LandingWatchReactor.settle")(function* (
    landings: ReadonlyMap<string, TrackedLanding>,
  ) {
    const rows = yield* threadsWithWaits(sql);
    const overview: { current?: SlipJayRunnerOverview | undefined; read: boolean } = {
      read: false,
    };
    for (const row of rows) {
      const thread = yield* projections.getThread(ThreadId.make(row.thread_id));
      yield* settleParked(thread, landings, overview);
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

  /** Production waits checked since they were parked, so a later edit of the thread does not recheck. */
  const checked = new Set<string>();
  const handle: LandingWatchReactor["Service"]["handle"] = (event) => {
    if (event.type !== "thread.metadata-updated") return Effect.void;
    const fresh = (event.payload.parkedWaits ?? []).filter(
      (wait) => wait.target.kind === "production" && !checked.has(wait.id),
    );
    if (fresh.length === 0) return Effect.void;
    for (const wait of fresh) checked.add(wait.id);
    return serial.withPermits(1)(
      settleParked({ ...event.payload, parkedWaits: fresh }, undefined, { read: false }),
    );
  };

  // The live commit moves only on a release; other runner changes leave Production as it was.
  let servedKey: string | undefined;
  const onRunner = (overview: SlipJayRunnerOverview) => {
    const key = `${overview.connected}:${overview.repositories
      .map((entry) => `${entry.repo}=${entry.release?.production.live?.commitId ?? ""}`)
      .join(",")}`;
    if (key === servedKey) return Effect.void;
    servedKey = key;
    return serial.withPermits(1)(
      Effect.gen(function* () {
        const rows = yield* threadsWithWaits(sql);
        for (const row of rows) {
          const thread = yield* projections.getThread(ThreadId.make(row.thread_id));
          yield* settleParked(thread, undefined, { current: overview, read: true });
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("production wait check failed", { cause })),
      ),
    );
  };

  return LandingWatchReactor.of({
    sweep,
    handle,
    start: Effect.fn("LandingWatchReactor.start")(function* () {
      yield* forkParked(slipJay.follow);
      yield* forkParked(Stream.runForEach(slipJay.changes, () => sweep));
      yield* forkParked(Stream.runForEach(slipJay.runner, onRunner));
      yield* forkParked(Stream.runForEach(engine.streamDomainEvents, handle));
      yield* forkParked(
        sweep.pipe(Effect.repeat(Schedule.spaced(`${SWEEP_MINUTES} minutes`)), Effect.asVoid),
      );
    }),
  });
});

export const layer = Layer.effect(LandingWatchReactor, make).pipe(Layer.provide(VcsProcess.layer));
