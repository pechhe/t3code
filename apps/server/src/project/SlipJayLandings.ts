import * as NodeOS from "node:os";

import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  SlipJayCommandError,
  type SlipJayRunnerOverview,
  type VcsSlipJayCancelInput,
  type VcsSlipJayCancelResult,
  type VcsSlipJayLandInput,
  type VcsSlipJayLandResult,
  type VcsSlipJayLandingDetailResult,
  type VcsSlipJayLandingLogInput,
  type VcsSlipJayLandingLogResult,
  type VcsStatusSlipJayLanding,
} from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import { findSlipJayProject } from "../vcs/SlipJayProject.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import {
  applyLandingOutcome,
  applyWatchEnvelope,
  emptyRunnerOverview,
  initialLandingWatchState,
  landingChanges,
  landingForOperation,
  parseLandingDetail,
  parseLandingOutcome,
  parseWatchLine,
  resolveWorkspaceLanding,
  runnerOverviewFromSnapshot,
  type LandingChange,
  type LandingOutcome,
  type LandingWatchState,
} from "./slipJayLandingState.ts";

const decodeLandVerdict = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      ok: Schema.Boolean,
      verdict: Schema.String,
      outcome: Schema.optional(
        Schema.Struct({
          operationId: Schema.String,
          publication: Schema.optional(Schema.Struct({ commitId: Schema.optional(Schema.String) })),
        }),
      ),
    }),
  ),
);

// `slipjay land` interleaves stages and gate output on stderr. Only these lines are
// kept: they report a change it made to the workspace, which no outcome records.
const LAND_WORKSPACE_LINE =
  /^(?:Could not |Abandon it |Kept landed workspace |Removed workspace: )/;

/** Why a landing did not publish, from its runner outcome when there is one. */
function notLandedReason(verdict: string, outcome: LandingOutcome | undefined): string {
  // SlipJay followed an older submission of this workspace and reports its verdict.
  if (verdict === "landed")
    return "SlipJay followed an older commit; land again to publish the current one.";
  if (!outcome?.terminal) return `SlipJay did not land this change (${verdict}).`;
  const where = `${outcome.status} at ${outcome.failure?.stage ?? outcome.stage}`;
  return outcome.failure === undefined ? where : `${where}: ${outcome.failure.reason}`;
}

/**
 * `slipjay land`'s result: its stdout verdict, the runner's `outcome` of a landing
 * that did not publish, and the workspace changes stderr reports. Without a verdict
 * SlipJay refused before submitting, and its last line says why.
 */
export function landResult(
  output: { readonly stdout: string; readonly stderr: string },
  outcome: LandingOutcome | undefined,
): VcsSlipJayLandResult {
  const verdict = Option.getOrUndefined(
    decodeLandVerdict(output.stdout.trim().split("\n").at(-1) ?? ""),
  );
  const lines = output.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const notices = lines.filter((line) => LAND_WORKSPACE_LINE.test(line));
  if (verdict === undefined)
    return {
      landed: false,
      verdict: null,
      operationId: null,
      commitId: null,
      messages: notices.length === 0 ? lines.slice(-1) : notices,
    };
  const landed = verdict.ok && verdict.verdict === "landed";
  const explanation = landed ? [] : [notLandedReason(verdict.verdict, outcome)];
  return {
    landed,
    verdict: verdict.verdict,
    operationId: verdict.outcome?.operationId ?? null,
    commitId: verdict.outcome?.publication?.commitId ?? null,
    messages: [...explanation, ...notices],
  };
}

const decodeLandedRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.NullOr(
      Schema.Struct({
        artifactCommitId: Schema.NonEmptyString,
        operationId: Schema.optional(Schema.NonEmptyString),
      }),
    ),
  ),
);

const decodeCancelRefusal = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ operation: Schema.Struct({ status: Schema.String }) })),
);

/**
 * `slipjay cancel`'s answer: cancelled, or refused because the operation is no longer
 * queued, which the runner answers with the operation itself. Anything else is a failure.
 */
export function cancelResult(output: {
  readonly stdout: string;
  readonly code: number | null;
}): VcsSlipJayCancelResult | undefined {
  if (output.code === 0) return { cancelled: true };
  return Option.isSome(decodeCancelRefusal(output.stdout.trim()))
    ? { cancelled: false }
    : undefined;
}

const LAND_OUTPUT_MAX_BYTES = 1024 * 1024;
const LANDING_LOG_MAX_BYTES = 2 * 1024 * 1024;
const WATCH_RESTART_DELAY = Duration.seconds(5);

/**
 * Landing state from SlipJay's runner for SlipJay workspaces' status. One
 * `slipjay watch --json` per server serves every thread on this host. It starts
 * when a SlipJay status first asks, and holds no runner credential of its own.
 */
export class SlipJayLandings extends Context.Service<
  SlipJayLandings,
  {
    /**
     * The latest landing of the change `workspaceRoot` would land, if this host saw
     * one. `integration` is the bookmark slipjay.json names.
     */
    readonly landingFor: (
      workspaceRoot: string,
      integration: string,
    ) => Effect.Effect<VcsStatusSlipJayLanding | undefined>;
    /**
     * What the SlipJay workspace that was at `cwd` landed, from SlipJay's own record, once
     * SlipJay has removed it. Undefined while `cwd` exists or when SlipJay recorded none.
     */
    readonly removedWorkspaceLanding: (
      cwd: string,
    ) => Effect.Effect<VcsStatusSlipJayLanding | undefined>;
    /** Emits each tracked landing that changes, or every landing when the watch connects or drops. */
    readonly changes: Stream.Stream<LandingChange>;
    /**
     * The repository key, as `changes` names it, of the SlipJay workspace holding `cwd`;
     * null when it has none.
     */
    readonly repositoryOf: (cwd: string) => Effect.Effect<string | null>;
    /** A tracked landing's runner log, read through `slipjay runner log`. */
    readonly readLog: (
      input: VcsSlipJayLandingLogInput,
    ) => Effect.Effect<VcsSlipJayLandingLogResult, SlipJayCommandError>;
    /** What the runner recorded of a tracked landing, read through `slipjay runner outcome`. */
    readonly readDetail: (
      input: VcsSlipJayLandingLogInput,
    ) => Effect.Effect<VcsSlipJayLandingDetailResult, SlipJayCommandError>;
    /**
     * Runs `slipjay land` in a workspace, as an agent would, and resolves with its
     * verdict. The landing outlives the request: an interrupted caller stops waiting,
     * not landing, and a second request for the workspace joins the running one.
     */
    readonly land: (
      input: VcsSlipJayLandInput,
    ) => Effect.Effect<VcsSlipJayLandResult, SlipJayCommandError>;
    /** Whether a landing this service started is still running for the workspace holding `cwd`. */
    readonly isLanding: (cwd: string) => Effect.Effect<boolean>;
    /**
     * The runner's lanes and recent deploys, current value first. Following it starts the
     * watch on a host with SlipJay installed; elsewhere it stays disconnected and empty.
     */
    readonly runner: Stream.Stream<SlipJayRunnerOverview>;
    /**
     * Follows the runner this machine's location now names: the watch restarts from the start
     * of that runner's ledger, and landings seen on the previous runner are forgotten.
     */
    readonly followRunnerChange: Effect.Effect<void>;
    /** Withdraws a queued operation with `slipjay cancel`; the runner refuses a started one. */
    readonly cancel: (
      input: VcsSlipJayCancelInput,
    ) => Effect.Effect<VcsSlipJayCancelResult, SlipJayCommandError>;
  }
>()("t3/project/SlipJayLandings") {}

/** `owner/name` of a GitHub remote URL, the key SlipJay's runner files a landing under. */
export const githubRepository = (remote: string): string | null => {
  let path: string;
  if (remote.includes("://")) {
    try {
      const url = new URL(remote);
      if (url.hostname.toLowerCase() !== "github.com") return null;
      path = url.pathname;
    } catch {
      return null;
    }
  } else {
    const scp = /^(?:[^@/:\s]+@)?github\.com:([^?#\s]+)$/i.exec(remote);
    if (!scp) return null;
    path = scp[1]!;
  }
  const match = /^\/?([A-Za-z0-9-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(path);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const processes = yield* ProcessRunner.ProcessRunner;
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const state = yield* Ref.make<LandingWatchState>(initialLandingWatchState);
  const changed = yield* PubSub.unbounded<LandingChange>();
  const started = yield* Ref.make(false);
  const reconciling = yield* Ref.make(new Set<string>());
  // The landing each workspace root was seen submitting; see resolveWorkspaceLanding.
  const submittedFrom = yield* Ref.make(new Map<string, string>());
  const overview = yield* SubscriptionRef.make(emptyRunnerOverview);
  // SlipJay names a submitting workspace `<host>:<workspace>` with this host's name.
  const host = NodeOS.hostname();
  const setOverview = (next: (current: SlipJayRunnerOverview) => SlipJayRunnerOverview) =>
    SubscriptionRef.get(overview).pipe(
      Effect.flatMap((current) => {
        const updated = next(current);
        // The watch repeats an unchanged snapshot after every heartbeat.
        return JSON.stringify(updated) === JSON.stringify(current)
          ? Effect.void
          : SubscriptionRef.set(overview, updated);
      }),
    );

  const transition = (next: (current: LandingWatchState) => LandingWatchState) =>
    Ref.modify(state, (current) => {
      const updated = next(current);
      return [landingChanges(current, updated), updated] as const;
    }).pipe(Effect.flatMap((changes) => PubSub.publishAll(changed, changes)));

  const readOutcome = (operationId: string) =>
    processes
      .run({
        command: "slipjay",
        args: ["runner", "outcome", operationId],
        timeout: "20 seconds",
        maxOutputBytes: 1024 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((output) =>
          output.code === 0 ? Option.getOrUndefined(parseLandingOutcome(output.stdout)) : undefined,
        ),
        Effect.orElseSucceed(() => undefined),
      );

  // A landing that left the queue while the watch could not see its terminal event
  // is settled from the runner's retained outcome, never assumed.
  const reconcile = (operationId: string) =>
    Ref.modify(reconciling, (pending) =>
      pending.has(operationId)
        ? [false, pending]
        : ([true, new Set(pending).add(operationId)] as const),
    ).pipe(
      Effect.flatMap((claimed) =>
        claimed
          ? readOutcome(operationId).pipe(
              Effect.flatMap((outcome) =>
                transition((current) => applyLandingOutcome(current, operationId, outcome)),
              ),
              Effect.ensuring(
                Ref.update(reconciling, (pending) => {
                  const next = new Set(pending);
                  next.delete(operationId);
                  return next;
                }),
              ),
            )
          : Effect.void,
      ),
    );

  const applyLine = (line: string) =>
    Option.match(parseWatchLine(line), {
      onNone: () => Effect.void,
      onSome: (envelope) => {
        const overviewUpdate =
          envelope.type === "snapshot"
            ? setOverview(() => runnerOverviewFromSnapshot(envelope.snapshot, host))
            : envelope.type === "connection"
              ? setOverview((current) => ({
                  ...current,
                  connected: envelope.state === "connected" && current.connected,
                }))
              : Effect.void;
        let vanished: ReadonlyArray<string> = [];
        return transition((current) => {
          const applied = applyWatchEnvelope(current, envelope);
          vanished = applied.vanished;
          return applied.state;
        }).pipe(
          Effect.andThen(overviewUpdate),
          Effect.andThen(
            Effect.suspend(() =>
              Effect.forEach(vanished, (id) => Effect.forkIn(reconcile(id), scope), {
                discard: true,
              }),
            ),
          ),
        );
      },
    });

  // The watch reconnects to the runner itself. A watch process that exits is
  // restarted from the last applied cursor; SlipJay bounds what it replays.
  const watchOnce = Effect.scoped(
    Effect.gen(function* () {
      const { cursor } = yield* Ref.get(state);
      const child = yield* spawner.spawn(
        ChildProcess.make("slipjay", ["watch", "--json"], {
          env: cursor > 0 ? { SLIPJAY_WATCH_CURSOR: String(cursor) } : {},
          extendEnv: true,
          shell: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        }),
      );
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach(applyLine),
      );
    }),
  );
  const watchForever = watchOnce.pipe(
    Effect.catchCause((cause) => Effect.logDebug("SlipJay landing watch stopped", cause)),
    Effect.andThen(transition((current) => ({ ...current, connected: false }))),
    Effect.andThen(setOverview((current) => ({ ...current, connected: false }))),
    Effect.andThen(Effect.sleep(WATCH_RESTART_DELAY)),
    Effect.forever,
  );
  const watching = yield* Ref.make<Fiber.Fiber<unknown, unknown> | undefined>(undefined);
  const ensureWatching = Ref.getAndSet(started, true).pipe(
    Effect.flatMap((already) =>
      already
        ? Effect.void
        : Effect.forkIn(watchForever, scope).pipe(
            Effect.flatMap((fiber) => Ref.set(watching, fiber)),
          ),
    ),
    Effect.asVoid,
  );
  // A cursor is a position in one runner's ledger, so a new runner is watched from its start.
  // One change at a time, so two at once cannot each start a watch and orphan one.
  const runnerChangeLock = yield* Semaphore.make(1);
  const followRunnerChange = Ref.get(watching).pipe(
    Effect.flatMap((fiber) =>
      fiber === undefined
        ? Effect.void
        : Fiber.interrupt(fiber).pipe(
            Effect.andThen(transition(() => initialLandingWatchState)),
            Effect.andThen(setOverview(() => emptyRunnerOverview)),
            Effect.andThen(Ref.set(started, false)),
            Effect.andThen(ensureWatching),
          ),
    ),
    runnerChangeLock.withPermits(1),
  );

  // The Jujutsu driver owns how a workspace is read; this service only follows SlipJay.
  const jjDriver = registry.get("jj").pipe(Effect.option);
  const workspaceRootOf = (cwd: string) =>
    registry.detect({ cwd }).pipe(
      Effect.map((handle) =>
        handle?.repository.kind === "jj" ? handle.repository.rootPath : null,
      ),
      Effect.orElseSucceed(() => null),
    );

  // The repository key a workspace's landings are filed under; remotes rarely change.
  const repositories = yield* Cache.makeWith(
    (workspaceRoot: string) =>
      Effect.gen(function* () {
        const project = yield* findSlipJayProject(workspaceRoot).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ProcessRunner.ProcessRunner, processes),
        );
        const driver = Option.getOrUndefined(yield* jjDriver);
        const remotes =
          driver === undefined
            ? []
            : (yield* driver
                .listRemotes(workspaceRoot)
                .pipe(Effect.orElseSucceed(() => ({ remotes: [] })))).remotes;
        const listed = remotes
          .map(({ name, url }) => ({ name, repository: githubRepository(url) }))
          .filter((entry) => entry.repository !== null);
        const remote = project?.remote ?? "origin";
        return (listed.find((entry) => entry.name === remote) ?? listed[0])?.repository ?? null;
      }),
    { capacity: 64, timeToLive: () => Duration.minutes(10) },
  );

  // `slipjay landed <path>` reads the record SlipJay keeps of each landing by its exact
  // workspace path, so it survives the workspace and a server restart. A landing never
  // changes, so it is kept; "none" is asked again shortly, as SlipJay records a landing
  // while removing the workspace. Hosts without SlipJay, or an older one, report none.
  const removedLandings = yield* Cache.makeWith(
    (cwd: string) =>
      processes
        .run({
          command: "slipjay",
          args: ["landed", cwd],
          timeout: "20 seconds",
          maxOutputBytes: 64 * 1024,
          outputMode: "truncate",
        })
        .pipe(
          Effect.map((output) => {
            const record =
              output.code === 0
                ? Option.getOrUndefined(decodeLandedRecord(output.stdout.trim()))
                : undefined;
            return record?.operationId === undefined
              ? undefined
              : ({
                  operationId: record.operationId,
                  status: "landed",
                  stage: "landed",
                  commitId: record.artifactCommitId,
                  // SlipJay's record is settled, not a report the watch may still revise.
                  live: true,
                } satisfies VcsStatusSlipJayLanding);
          }),
          Effect.orElseSucceed(() => undefined),
        ),
    {
      capacity: 256,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value !== undefined ? Duration.hours(24) : Duration.minutes(1),
    },
  );

  const removedWorkspaceLanding: SlipJayLandings["Service"]["removedWorkspaceLanding"] = (cwd) =>
    fs.exists(cwd).pipe(
      Effect.orElseSucceed(() => true),
      Effect.flatMap((exists) =>
        exists ? Effect.succeed(undefined) : Cache.get(removedLandings, cwd),
      ),
    );

  const repositoryOf: SlipJayLandings["Service"]["repositoryOf"] = (cwd) =>
    workspaceRootOf(cwd).pipe(
      Effect.flatMap((root) =>
        root === null ? Effect.succeed(null) : Cache.get(repositories, root),
      ),
    );

  const landingFor: SlipJayLandings["Service"]["landingFor"] = Effect.fn(
    "SlipJayLandings.landingFor",
  )(function* (workspaceRoot, integration) {
    yield* ensureWatching;
    const repository = yield* Cache.get(repositories, workspaceRoot);
    if (repository === null) return undefined;
    const driver = Option.getOrUndefined(yield* jjDriver);
    const candidate =
      driver?.slipJayLandCandidate === undefined
        ? null
        : yield* driver
            .slipJayLandCandidate({ cwd: workspaceRoot, integration })
            .pipe(Effect.orElseSucceed(() => null));
    if (candidate === null) return undefined;
    const current = yield* Ref.get(state);
    const resolved = resolveWorkspaceLanding(
      current,
      repository,
      candidate,
      (yield* Ref.get(submittedFrom)).get(workspaceRoot),
    );
    yield* Ref.update(submittedFrom, (roots) => {
      const next = new Map(roots);
      if (resolved.submitted === undefined) next.delete(workspaceRoot);
      else next.set(workspaceRoot, resolved.submitted);
      return next;
    });
    return resolved.landing;
  });

  // Only the landing the strip shows: one this host tracks for the checkout's repository,
  // or a removed workspace's own. A client cannot read arbitrary runner operations.
  const isShownLanding = Effect.fn("SlipJayLandings.isShownLanding")(function* (
    cwd: string,
    operationId: string,
  ) {
    const removed = yield* removedWorkspaceLanding(cwd);
    if (removed !== undefined) return removed.operationId === operationId;
    const repository = yield* Cache.get(repositories, cwd);
    return (
      repository !== null &&
      landingForOperation(yield* Ref.get(state), repository, operationId) !== undefined
    );
  });

  // The runner, not the checkout, answers these; the workspace may be gone.
  const readRunner = Effect.fn("SlipJayLandings.readRunner")(function* (
    { cwd, operationId }: VcsSlipJayLandingLogInput,
    request: {
      readonly operation: string;
      readonly subcommand: "log" | "outcome";
      readonly timeout: Duration.Input;
      readonly maxOutputBytes: number;
      readonly what: string;
    },
  ) {
    const command = `slipjay runner ${request.subcommand}`;
    const failure = (
      detail: string,
      extra: { readonly exitCode?: number; readonly cause?: unknown } = {},
    ) =>
      new SlipJayCommandError({
        operation: request.operation,
        command,
        cwd,
        detail,
        ...extra,
      });
    if (!(yield* isShownLanding(cwd, operationId)))
      return yield* failure("This landing is not tracked for this workspace.");
    const output = yield* processes
      .run({
        command: "slipjay",
        args: ["runner", request.subcommand, operationId],
        timeout: request.timeout,
        maxOutputBytes: request.maxOutputBytes,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError((cause) =>
          failure(`SlipJay could not be run to read the ${request.what}.`, { cause }),
        ),
      );
    // SlipJay's stderr can carry runner URLs and paths, so it stays on the server.
    if (output.code !== 0)
      return yield* failure(
        `SlipJay could not read the ${request.what}. Run \`${command}\` on the server for details.`,
        output.code === null ? {} : { exitCode: output.code },
      );
    return { output, failure };
  });

  const readLog: SlipJayLandings["Service"]["readLog"] = Effect.fn("SlipJayLandings.readLog")(
    function* (input) {
      const { output } = yield* readRunner(input, {
        operation: "SlipJayLandings.readLog",
        subcommand: "log",
        timeout: "30 seconds",
        maxOutputBytes: LANDING_LOG_MAX_BYTES,
        what: "landing log",
      });
      return { log: output.stdout, truncated: output.stdoutTruncated };
    },
  );

  const readDetail: SlipJayLandings["Service"]["readDetail"] = Effect.fn(
    "SlipJayLandings.readDetail",
  )(function* (input) {
    const { output, failure } = yield* readRunner(input, {
      operation: "SlipJayLandings.readDetail",
      subcommand: "outcome",
      timeout: "20 seconds",
      maxOutputBytes: 1024 * 1024,
      what: "landing outcome",
    });
    const detail = parseLandingDetail(output.stdout);
    if (Option.isNone(detail))
      return yield* failure("SlipJay reported this landing in an unexpected form.");
    return detail.value;
  });

  const runLand = (cwd: string) =>
    processes
      .run({
        command: "slipjay",
        args: ["land"],
        cwd,
        // Queueing and the gate take minutes; the runner, not this wait, bounds them.
        timeout: "3 hours",
        maxOutputBytes: LAND_OUTPUT_MAX_BYTES,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SlipJayCommandError({
              operation: "SlipJayLandings.land",
              command: "slipjay land",
              cwd,
              detail: "SlipJay could not be run to land this workspace.",
              cause,
            }),
        ),
        Effect.flatMap((output) => {
          const verdict = landResult(output, undefined);
          // A landing that did not publish reports why from its runner outcome, the
          // record the strip shows, rather than from the lines it printed.
          return verdict.landed || verdict.operationId === null
            ? Effect.succeed(verdict)
            : readOutcome(verdict.operationId).pipe(
                Effect.map((outcome) => landResult(output, outcome)),
              );
        }),
      );

  const lands = yield* Ref.make(
    new Map<string, Deferred.Deferred<VcsSlipJayLandResult, SlipJayCommandError>>(),
  );
  const land: SlipJayLandings["Service"]["land"] = Effect.fn("SlipJayLandings.land")(function* ({
    cwd,
  }) {
    const refuse = (detail: string) =>
      new SlipJayCommandError({
        operation: "SlipJayLandings.land",
        command: "slipjay land",
        cwd,
        detail,
      });
    // One landing per workspace, however the caller names a path inside it. SlipJay
    // refuses, in its own words, a checkout it would not land.
    const root = yield* workspaceRootOf(cwd);
    if (!root) return yield* refuse("This is not a Jujutsu workspace.");
    // Registering and starting are one step, so an interrupted caller cannot leave a
    // registration that no landing will ever settle.
    const landing = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const started = yield* Deferred.make<VcsSlipJayLandResult, SlipJayCommandError>();
        const running = yield* Ref.modify(lands, (current) => {
          const existing = current.get(root);
          return existing === undefined
            ? [undefined, new Map(current).set(root, started)]
            : [existing, current];
        });
        if (running !== undefined) return running;
        yield* runLand(root).pipe(
          Effect.onExit((exit) => Deferred.done(started, exit)),
          Effect.ensuring(
            Ref.update(lands, (current) => {
              const next = new Map(current);
              next.delete(root);
              return next;
            }),
          ),
          Effect.forkIn(scope),
        );
        return started;
      }),
    );
    return yield* Deferred.await(landing);
  });

  const isLanding: SlipJayLandings["Service"]["isLanding"] = (cwd) =>
    workspaceRootOf(cwd).pipe(
      Effect.flatMap((root) =>
        root === null
          ? Effect.succeed(false)
          : Ref.get(lands).pipe(Effect.map((current) => current.has(root))),
      ),
    );

  // A host without SlipJay has no runner to follow, so it never starts a watch to retry.
  // Each new follower asks again until the watch starts, so installing SlipJay later works.
  const slipJayInstalled = processes
    .run({
      command: "slipjay",
      args: ["--version"],
      timeout: "10 seconds",
      maxOutputBytes: 4 * 1024,
      outputMode: "truncate",
    })
    .pipe(
      Effect.map((output) => output.code === 0),
      Effect.orElseSucceed(() => false),
    );
  const runner: SlipJayLandings["Service"]["runner"] = Stream.unwrap(
    Ref.get(started).pipe(
      Effect.flatMap((watching) => (watching ? Effect.succeed(false) : slipJayInstalled)),
      Effect.flatMap((installed) => (installed ? ensureWatching : Effect.void)),
      Effect.as(SubscriptionRef.changes(overview)),
    ),
  );

  const cancel: SlipJayLandings["Service"]["cancel"] = Effect.fn("SlipJayLandings.cancel")(
    function* ({ operationId }) {
      const failure = (
        detail: string,
        extra: { readonly exitCode?: number; readonly cause?: unknown } = {},
      ) =>
        new SlipJayCommandError({
          operation: "SlipJayLandings.cancel",
          command: "slipjay cancel",
          cwd: "",
          detail,
          ...extra,
        });
      // Only an operation the overview shows queued: a client cannot name arbitrary ones.
      const current = yield* SubscriptionRef.get(overview);
      const queued = [...current.serial, ...current.deploy].some(
        (operation) => operation.operationId === operationId && operation.status === "queued",
      );
      if (!queued) return yield* failure("This operation is no longer queued.");
      const output = yield* processes
        .run({
          command: "slipjay",
          args: ["cancel", operationId],
          timeout: "30 seconds",
          maxOutputBytes: 64 * 1024,
          outputMode: "truncate",
        })
        .pipe(
          Effect.mapError((cause) => failure("SlipJay could not be run to cancel.", { cause })),
        );
      const result = cancelResult(output);
      if (result !== undefined) return result;
      return yield* failure(
        "SlipJay could not cancel. Run `slipjay cancel` on the server for details.",
        output.code === null ? undefined : { exitCode: output.code },
      );
    },
  );

  return SlipJayLandings.of({
    runner,
    followRunnerChange,
    cancel,
    land,
    isLanding,
    landingFor,
    removedWorkspaceLanding,
    changes: Stream.fromPubSub(changed),
    repositoryOf,
    readLog,
    readDetail,
  });
});

export const layer = Layer.effect(SlipJayLandings, make).pipe(Layer.provide(ProcessRunner.layer));

/** For tests and hosts without SlipJay: no landings, and no watch is started. */
export const layerNone = Layer.succeed(
  SlipJayLandings,
  SlipJayLandings.of({
    landingFor: () => Effect.succeed(undefined),
    removedWorkspaceLanding: () => Effect.succeed(undefined),
    changes: Stream.empty,
    runner: Stream.make(emptyRunnerOverview),
    followRunnerChange: Effect.void,
    cancel: () =>
      Effect.fail(
        new SlipJayCommandError({
          operation: "SlipJayLandings.cancel",
          command: "slipjay cancel",
          cwd: "",
          detail: "SlipJay is not available on this host.",
        }),
      ),
    repositoryOf: () => Effect.succeed(null),
    isLanding: () => Effect.succeed(false),
    land: ({ cwd }) =>
      Effect.fail(
        new SlipJayCommandError({
          operation: "SlipJayLandings.land",
          command: "slipjay land",
          cwd,
          detail: "SlipJay is not available on this host.",
        }),
      ),
    readLog: ({ cwd }) =>
      Effect.fail(
        new SlipJayCommandError({
          operation: "SlipJayLandings.readLog",
          command: "slipjay runner log",
          cwd,
          detail: "SlipJay is not available on this host.",
        }),
      ),
    readDetail: ({ cwd }) =>
      Effect.fail(
        new SlipJayCommandError({
          operation: "SlipJayLandings.readDetail",
          command: "slipjay runner outcome",
          cwd,
          detail: "SlipJay is not available on this host.",
        }),
      ),
  }),
);
