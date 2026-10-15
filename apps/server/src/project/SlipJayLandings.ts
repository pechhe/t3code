import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  GitCommandError,
  type VcsSlipJayLandInput,
  type VcsSlipJayLandResult,
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
  initialLandingWatchState,
  landingForOperation,
  parseLandingOutcome,
  parseWatchLine,
  resolveWorkspaceLanding,
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
    /** Emits when any tracked landing, or the watch's connection, changes. */
    readonly changes: Stream.Stream<void>;
    /** A tracked landing's runner log, read through `slipjay runner log`. */
    readonly readLog: (
      input: VcsSlipJayLandingLogInput,
    ) => Effect.Effect<VcsSlipJayLandingLogResult, GitCommandError>;
    /**
     * Runs `slipjay land` in a workspace, as an agent would, and resolves with its
     * verdict. The landing outlives the request: an interrupted caller stops waiting,
     * not landing, and a second request for the workspace joins the running one.
     */
    readonly land: (
      input: VcsSlipJayLandInput,
    ) => Effect.Effect<VcsSlipJayLandResult, GitCommandError>;
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
  const changed = yield* PubSub.unbounded<void>();
  const started = yield* Ref.make(false);
  const reconciling = yield* Ref.make(new Set<string>());
  // The landing each workspace root was seen submitting; see resolveWorkspaceLanding.
  const submittedFrom = yield* Ref.make(new Map<string, string>());

  const transition = (next: (current: LandingWatchState) => LandingWatchState) =>
    Ref.modify(state, (current) => {
      const updated = next(current);
      return [
        current.operations !== updated.operations || current.connected !== updated.connected,
        updated,
      ] as const;
    }).pipe(
      Effect.flatMap((published) => (published ? PubSub.publish(changed, undefined) : Effect.void)),
    );

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
        let vanished: ReadonlyArray<string> = [];
        return transition((current) => {
          const applied = applyWatchEnvelope(current, envelope);
          vanished = applied.vanished;
          return applied.state;
        }).pipe(
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
    Effect.andThen(Effect.sleep(WATCH_RESTART_DELAY)),
    Effect.forever,
  );
  const ensureWatching = Ref.getAndSet(started, true).pipe(
    Effect.flatMap((already) => (already ? Effect.void : Effect.forkIn(watchForever, scope))),
    Effect.asVoid,
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

  const readLog: SlipJayLandings["Service"]["readLog"] = Effect.fn("SlipJayLandings.readLog")(
    function* ({ cwd, operationId }) {
      const failure = (detail: string, exitCode?: number) =>
        new GitCommandError({
          operation: "SlipJayLandings.readLog",
          command: "slipjay runner log",
          cwd,
          detail,
          ...(exitCode === undefined ? {} : { exitCode }),
        });
      // Only a landing this host tracks for the checkout's repository: the strip offers
      // no other, and a client cannot read arbitrary runner operations through it.
      const repository = yield* Cache.get(repositories, cwd);
      if (
        repository === null ||
        landingForOperation(yield* Ref.get(state), repository, operationId) === undefined
      )
        return yield* failure("This landing is not tracked for this workspace.");
      const output = yield* processes
        .run({
          command: "slipjay",
          args: ["runner", "log", operationId],
          cwd,
          timeout: "30 seconds",
          maxOutputBytes: LANDING_LOG_MAX_BYTES,
          outputMode: "truncate",
        })
        .pipe(Effect.mapError(() => failure("SlipJay could not be run to read the landing log.")));
      if (output.code !== 0)
        return yield* failure(
          output.stderr.trim() || "SlipJay could not read the landing log.",
          output.code ?? undefined,
        );
      return { log: output.stdout, truncated: output.stdoutTruncated };
    },
  );

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
          () =>
            new GitCommandError({
              operation: "SlipJayLandings.land",
              command: "slipjay land",
              cwd,
              detail: "SlipJay could not be run to land this workspace.",
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
    new Map<string, Deferred.Deferred<VcsSlipJayLandResult, GitCommandError>>(),
  );
  const land: SlipJayLandings["Service"]["land"] = Effect.fn("SlipJayLandings.land")(function* ({
    cwd,
  }) {
    const refuse = (detail: string) =>
      new GitCommandError({
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
        const started = yield* Deferred.make<VcsSlipJayLandResult, GitCommandError>();
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

  return SlipJayLandings.of({
    land,
    landingFor,
    changes: Stream.fromPubSub(changed),
    readLog,
  });
});

export const layer = Layer.effect(SlipJayLandings, make).pipe(Layer.provide(ProcessRunner.layer));

/** For tests and hosts without SlipJay: no landings, and no watch is started. */
export const layerNone = Layer.succeed(
  SlipJayLandings,
  SlipJayLandings.of({
    landingFor: () => Effect.succeed(undefined),
    changes: Stream.empty,
    land: ({ cwd }) =>
      Effect.fail(
        new GitCommandError({
          operation: "SlipJayLandings.land",
          command: "slipjay land",
          cwd,
          detail: "SlipJay is not available on this host.",
        }),
      ),
    readLog: ({ cwd }) =>
      Effect.fail(
        new GitCommandError({
          operation: "SlipJayLandings.readLog",
          command: "slipjay runner log",
          cwd,
          detail: "SlipJay is not available on this host.",
        }),
      ),
  }),
);
