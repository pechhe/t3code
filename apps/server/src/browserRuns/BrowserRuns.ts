import {
  OrchestratorMcpFailure,
  type ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";

/** Names the run a `t3 browser run` request belongs to, on the browser-run endpoint only. */
export const BROWSER_RUN_HEADER = "t3-browser-run";

export const BROWSER_RUN_LIMITS = {
  defaultSeconds: 300,
  maxSeconds: 1_800,
  defaultOutputBytes: 4 * 1024 * 1024,
  maxOutputBytes: 32 * 1024 * 1024,
} as const;

export type BrowserRunOutcome = "succeeded" | "failed" | "time-limit" | "output-limit";

export interface BrowserRunSummary {
  readonly runId: string;
  readonly outcome: BrowserRunOutcome;
  readonly durationMs: number;
  readonly tabs: number;
  readonly outputBytes: number;
}

export interface BrowserRun {
  readonly runId: string;
  /** The scope the run's browser calls act with: its own run lane, on its project's browser. */
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
  readonly projectId: ProjectId;
  readonly deadline: number;
  readonly outputLimitBytes: number;
}

interface RunState extends BrowserRun {
  /** Who opened it: only the same credential may use or close it. */
  readonly opener: string;
  readonly threadId: ThreadId | undefined;
  readonly harness: string;
  readonly startedAt: number;
  readonly outputBytes: number;
  readonly tabs: ReadonlySet<string>;
  readonly timer: Fiber.Fiber<void> | undefined;
}

const KEEP_FOR = Duration.days(90);
/** Recently ended runs kept so their opener's close still learns why one ended early. */
const ENDED_KEPT = 64;

const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/** The credential a request came on: a thread's provider session or an outside client's session. */
const openerOf = (scope: McpInvocationContext.McpInvocationScope): string =>
  scope.thread !== undefined
    ? `thread:${scope.thread.providerSessionId}`
    : `client:${scope.client?.sessionId ?? ""}`;

/**
 * Browser runs: `t3 browser run`'s scripts, each with its own tabs sharing one fresh context, a
 * deadline and an output budget. The server owns them, so a killed script's tabs still close by
 * its deadline, and each run leaves one record that `t3 browser report` counts.
 */
export class BrowserRuns extends Context.Service<
  BrowserRuns,
  {
    readonly open: (input: {
      readonly caller: McpInvocationContext.McpInvocationScope;
      /** The run's browser scope before its lane is named: bounded, integrated, on its project. */
      readonly browserScope: (runId: string) => McpInvocationContext.McpThreadInvocationScope;
      readonly projectId: ProjectId;
      readonly timeLimitSeconds?: number | undefined;
      readonly outputLimitBytes?: number | undefined;
    }) => Effect.Effect<BrowserRun>;
    /** The caller's live run, or a refusal naming why it cannot be used. */
    readonly use: (
      caller: McpInvocationContext.McpInvocationScope,
      runId: string | undefined,
    ) => Effect.Effect<BrowserRun, OrchestratorMcpFailure>;
    readonly noteTab: (runId: string, tabId: string) => Effect.Effect<void>;
    /** The run's open tabs, pop-ups it opened included, oldest first. */
    readonly tabs: (
      scope: McpInvocationContext.McpThreadInvocationScope,
    ) => Effect.Effect<ReadonlyArray<{ readonly tabId: string; readonly url: string | null }>>;
    /** Counts a result against the run's output limit; ends the run when it goes over. */
    readonly charge: (runId: string, bytes: number) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly close: (
      caller: McpInvocationContext.McpInvocationScope,
      runId: string | undefined,
      outcome: "succeeded" | "failed",
    ) => Effect.Effect<BrowserRunSummary, OrchestratorMcpFailure>;
  }
>()("t3/browserRuns/BrowserRuns") {}

/** The scope a client's run acts with: no T3 thread, so the run is its own browser owner. */
export const clientRunScope = (
  caller: McpInvocationContext.McpInvocationScope,
  projectId: ProjectId,
  runId: string,
): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId: caller.environmentId,
  issuedAt: caller.issuedAt,
  requestNamespace: `browser-run:${runId}`,
  capabilities: new Set(["preview"]),
  thread: {
    threadId: ThreadId.make(`browser-run:${runId}`),
    providerSessionId: `browser-run:${runId}`,
    providerInstanceId: ProviderInstanceId.make("t3-browser-run"),
  },
  client: undefined,
  managedBrowser: true,
  managedProjectId: projectId,
  taskBrowser: { backend: "integrated" },
  browserBackends: { enabled: ["integrated"], default: "integrated" },
});

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const previews = yield* Effect.serviceOption(PreviewManager.PreviewManager);
  const browser = yield* Effect.serviceOption(ServerBrowser.ServerBrowser);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const adapters = yield* Effect.serviceOption(ProviderAdapterRegistry.ProviderAdapterRegistryV2);
  const timers = yield* FiberSet.make<void, never>();
  const runs = yield* SynchronizedRef.make<ReadonlyMap<string, RunState>>(new Map());
  const ended = yield* SynchronizedRef.make<
    ReadonlyMap<string, { readonly opener: string; readonly summary: BrowserRunSummary }>
  >(new Map());

  const harnessOf = (scope: McpInvocationContext.McpInvocationScope) =>
    scope.thread === undefined
      ? Effect.succeed("client")
      : Option.isNone(adapters)
        ? Effect.succeed(String(scope.thread.providerInstanceId))
        : adapters.value.get(scope.thread.providerInstanceId).pipe(
            Effect.map((adapter): string => adapter.driver),
            Effect.orElseSucceed(() => String(scope.thread!.providerInstanceId)),
          );

  const ownTabs = Effect.fn("BrowserRuns.ownTabs")(function* (
    scope: McpInvocationContext.McpThreadInvocationScope,
  ) {
    if (Option.isNone(previews)) return [];
    const owner = McpInvocationContext.browserOwnerKey(scope);
    const { sessions } = yield* previews.value.list({ threadId: scope.thread.threadId });
    return sessions.filter((tab) => tab.automationOwner === owner);
  });

  const closeTabs = Effect.fn("BrowserRuns.closeTabs")(function* (run: RunState) {
    if (Option.isNone(previews)) return;
    const manager = previews.value;
    yield* Effect.forEach(
      yield* ownTabs(run.scope),
      (tab) =>
        manager
          .close({ threadId: ThreadId.make(tab.threadId), tabId: tab.tabId })
          .pipe(Effect.ignore),
      { discard: true },
    );
  });

  const record = Effect.fn("BrowserRuns.record")(
    function* (run: RunState, summary: BrowserRunSummary) {
      if (Option.isNone(sql)) return;
      const client = sql.value;
      const now = yield* DateTime.now;
      const cutoff = DateTime.formatIso(DateTime.subtractDuration(now, KEEP_FOR));
      yield* client.withTransaction(
        Effect.all([
          client`INSERT INTO browser_script_runs (
            recorded_at, harness, thread_id, project_id, outcome, duration_ms, tabs, output_bytes
          ) VALUES (
            ${DateTime.formatIso(now)}, ${run.harness}, ${run.threadId ?? null},
            ${run.projectId}, ${summary.outcome}, ${Math.round(summary.durationMs)},
            ${summary.tabs}, ${summary.outputBytes}
          )`,
          client`DELETE FROM browser_script_runs WHERE recorded_at < ${cutoff}`,
        ]),
      );
    },
    Effect.catchCause((cause) => Effect.logWarning("Could not record a browser run.", { cause })),
  );

  /** Ends a run once, however it ends: its tabs close and it leaves one record. */
  const end = Effect.fn("BrowserRuns.end")(function* (runId: string, outcome: BrowserRunOutcome) {
    const run = yield* SynchronizedRef.modify(runs, (current) => {
      const found = current.get(runId);
      if (found === undefined) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(runId);
      return [found, next] as const;
    });
    if (run === undefined) return undefined;
    const endedAt = yield* Clock.currentTimeMillis;
    const summary: BrowserRunSummary = {
      runId,
      outcome,
      durationMs: Math.max(0, endedAt - run.startedAt),
      tabs: run.tabs.size,
      outputBytes: run.outputBytes,
    };
    yield* closeTabs(run).pipe(Effect.ignore);
    if (Option.isSome(browser))
      yield* browser.value.endRun({
        agentSessionId: McpInvocationContext.browserOwnerKey(run.scope),
      });
    yield* record(run, summary);
    yield* SynchronizedRef.update(ended, (current) => {
      const next = new Map(current).set(runId, { opener: run.opener, summary });
      for (const oldest of next.keys()) {
        if (next.size <= ENDED_KEPT) break;
        next.delete(oldest);
      }
      return next;
    });
    return summary;
  }, Effect.uninterruptible);

  const notFound = refuse(
    "No open browser run on this connection. Open one with t3_browser_run_open; a run ends at its time limit.",
  );

  return BrowserRuns.of({
    open: Effect.fn("BrowserRuns.open")(function* (input) {
      const runId = yield* random.uuidV4();
      const startedAt = yield* Clock.currentTimeMillis;
      const seconds = Math.min(
        BROWSER_RUN_LIMITS.maxSeconds,
        Math.max(1, Math.round(input.timeLimitSeconds ?? BROWSER_RUN_LIMITS.defaultSeconds)),
      );
      const outputLimitBytes = Math.min(
        BROWSER_RUN_LIMITS.maxOutputBytes,
        Math.max(1, Math.round(input.outputLimitBytes ?? BROWSER_RUN_LIMITS.defaultOutputBytes)),
      );
      const deadline = startedAt + seconds * 1_000;
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        ...input.browserScope(runId),
        browserLane: "run",
        browserRunId: runId,
      };
      const timer = yield* FiberSet.run(
        timers,
        Effect.sleep(Duration.seconds(seconds)).pipe(
          Effect.andThen(end(runId, "time-limit")),
          Effect.asVoid,
        ),
      );
      const harness = yield* harnessOf(input.caller);
      yield* SynchronizedRef.update(runs, (current) =>
        new Map(current).set(runId, {
          runId,
          scope,
          projectId: input.projectId,
          deadline,
          outputLimitBytes,
          opener: openerOf(input.caller),
          threadId: input.caller.thread?.threadId,
          harness,
          startedAt,
          outputBytes: 0,
          tabs: new Set(),
          timer,
        }),
      );
      return { runId, scope, projectId: input.projectId, deadline, outputLimitBytes };
    }),
    use: Effect.fn("BrowserRuns.use")(function* (caller, runId) {
      if (runId === undefined) return yield* notFound;
      const run = (yield* SynchronizedRef.get(runs)).get(runId);
      if (run === undefined || run.opener !== openerOf(caller)) return yield* notFound;
      return run;
    }),
    noteTab: Effect.fn("BrowserRuns.noteTab")(function* (runId, tabId) {
      yield* SynchronizedRef.update(runs, (current) => {
        const run = current.get(runId);
        if (run === undefined || run.tabs.has(tabId)) return current;
        return new Map(current).set(runId, { ...run, tabs: new Set([...run.tabs, tabId]) });
      });
    }),
    tabs: Effect.fn("BrowserRuns.tabs")(function* (scope) {
      return (yield* ownTabs(scope)).map((tab) => ({
        tabId: tab.tabId,
        url: "url" in tab.navStatus ? tab.navStatus.url : null,
      }));
    }),
    charge: Effect.fn("BrowserRuns.charge")(function* (runId, bytes) {
      const over = yield* SynchronizedRef.modify(runs, (current) => {
        const run = current.get(runId);
        if (run === undefined) return [false, current] as const;
        const outputBytes = run.outputBytes + Math.max(0, bytes);
        return [
          outputBytes > run.outputLimitBytes,
          new Map(current).set(runId, { ...run, outputBytes }),
        ] as const;
      });
      if (!over) return;
      yield* end(runId, "output-limit");
      return yield* refuse(
        "This browser run went over its output limit and has ended. Return less, or raise the limit when you open the run.",
      );
    }),
    close: Effect.fn("BrowserRuns.close")(function* (caller, runId, outcome) {
      const run = runId === undefined ? undefined : (yield* SynchronizedRef.get(runs)).get(runId);
      if (run === undefined) {
        // The server already ended it (time or output limit): answer with what it recorded.
        const gone =
          runId === undefined ? undefined : (yield* SynchronizedRef.get(ended)).get(runId);
        return gone !== undefined && gone.opener === openerOf(caller)
          ? gone.summary
          : yield* notFound;
      }
      if (run.opener !== openerOf(caller)) return yield* notFound;
      if (run.timer !== undefined) yield* Fiber.interrupt(run.timer);
      const summary = yield* end(run.runId, outcome);
      return summary ?? (yield* notFound);
    }),
  });
});

export const layer = Layer.effect(BrowserRuns, make);
