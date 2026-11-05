import {
  type DecisionError,
  OrchestratorMcpFailure,
  PREVIEW_TASK_LIMITS,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewTabId,
  type PreviewTaskRequest,
  type PreviewTaskResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as DecisionService from "../decisions/DecisionService.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import { saveBrowserScreenshot } from "../preview/browserArtifacts.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import {
  type BrowserTaskPort,
  emptyRecord,
  type PortFailure,
  resolveLimits,
  runBrowserTask,
  type RunRecord,
} from "./BrowserTaskRunner.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/** Run IDs live with the server, and a restart ends every tab, so a retry is refused rather than rerun. */
const TAB_UNAVAILABLE_GUIDANCE =
  "If the tab closed or the server restarted, an earlier task on it may still have taken effect: open a new tab, read the page, and only repeat work under a new requestId.";

const CONTROL_LABELS = new Set(["SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"]);
/** Long enough that a finished run reports its released lease; short enough not to hold the caller. */
const RELEASE_GRACE_MS = 500;

const duplicate = (ids: readonly string[]) => ids.find((id, index) => ids.indexOf(id) !== index);

/** Rejects what can be known wrong before any provider call or browser effect. */
export const requestProblem = (request: PreviewTaskRequest): string | undefined => {
  const bindings = request.bindings ?? [];
  const actions = request.actions ?? [];
  const steps = [
    ...bindings.map((binding) => binding.id),
    ...actions.map((action) => action.id),
    ...(request.submit === undefined ? [] : [request.submit.id]),
  ];
  const repeated = duplicate(steps);
  if (repeated !== undefined) return `Step id ${repeated} is used twice.`;
  const reserved = steps.find((id) => CONTROL_LABELS.has(id));
  if (reserved !== undefined) return `Step id ${reserved} is reserved.`;
  if (bindings.length > PREVIEW_TASK_LIMITS.bindings)
    return `At most ${PREVIEW_TASK_LIMITS.bindings} bindings are allowed.`;
  if (actions.length > PREVIEW_TASK_LIMITS.actions)
    return `At most ${PREVIEW_TASK_LIMITS.actions} actions are allowed.`;
  if (request.checks.length === 0) return "Name at least one check.";
  if (request.checks.length > PREVIEW_TASK_LIMITS.checks)
    return `At most ${PREVIEW_TASK_LIMITS.checks} checks are allowed.`;
  const repeatedCheck = duplicate(request.checks.map((check) => check.id));
  if (repeatedCheck !== undefined) return `Check id ${repeatedCheck} is used twice.`;
  for (const check of request.checks) {
    if (check.kind === "url" && check.equals === undefined && check.includes === undefined)
      return `URL check ${check.id} needs equals or includes.`;
    if (
      check.kind === "target" &&
      check.expect === "absent" &&
      (check.value !== undefined || check.checked !== undefined)
    )
      return `Absence check ${check.id} cannot also expect a value or state.`;
  }
  const artifactChecks = request.checks.filter((check) => check.kind === "artifact");
  if (artifactChecks.length > 1) return "Name one artifact check.";
  if ((artifactChecks.length === 1) !== (request.capture !== undefined))
    return "A capture and an artifact check go together.";
  const { maxActions, maxDecisions, timeoutMs } = request.limits ?? {};
  if (maxActions !== undefined && (maxActions < 1 || maxActions > PREVIEW_TASK_LIMITS.maxActions))
    return `maxActions must be 1 to ${PREVIEW_TASK_LIMITS.maxActions}.`;
  if (
    maxDecisions !== undefined &&
    (maxDecisions < 1 || maxDecisions > PREVIEW_TASK_LIMITS.maxDecisions)
  )
    return `maxDecisions must be 1 to ${PREVIEW_TASK_LIMITS.maxDecisions}.`;
  if (timeoutMs !== undefined && (timeoutMs < 1 || timeoutMs > PREVIEW_TASK_LIMITS.maxElapsedMs))
    return `timeoutMs must be 1 to ${PREVIEW_TASK_LIMITS.maxElapsedMs}.`;
  return undefined;
};

export type TaskPort = Omit<BrowserTaskPort, "authorize">;

export interface TaskBackend {
  /** The tab exists and belongs to this scope; refused otherwise, with no effect. */
  readonly assertOwnedTab: (
    scope: McpThreadInvocationScope,
    tabId: PreviewTabId,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly port: (scope: McpThreadInvocationScope, tabId: PreviewTabId, lease: string) => TaskPort;
  readonly release: (
    scope: McpThreadInvocationScope,
    tabId: PreviewTabId,
    lease: string,
    options: { readonly leased: boolean; readonly inspectFirst: boolean },
  ) => Effect.Effect<"released" | "tab-lost">;
  readonly credentialState: McpSessionRegistry.McpSessionRegistryShape["credentialState"];
}

interface RunEntry {
  readonly digest: string;
  readonly record: RunRecord;
  readonly cancelled: Deferred.Deferred<void>;
  /** A terminal record exists, and the lease is released or the grace has passed. */
  readonly reported: Deferred.Deferred<void>;
}

interface SessionJournal {
  readonly providerSessionId: string;
  readonly runs: Map<string, RunEntry>;
}

export class BrowserTaskService extends Context.Service<
  BrowserTaskService,
  {
    readonly run: (input: {
      readonly scope: McpThreadInvocationScope;
      readonly request: PreviewTaskRequest;
      readonly authorize: BrowserTaskPort["authorize"];
    }) => Effect.Effect<PreviewTaskResult, OrchestratorMcpFailure>;
    readonly cancel: (input: {
      readonly scope: McpThreadInvocationScope;
      readonly requestId: string;
    }) => Effect.Effect<PreviewTaskResult, OrchestratorMcpFailure>;
  }
>()("t3/browserTasks/BrowserTaskService") {}

const toResult = (record: RunRecord, replayed: boolean): PreviewTaskResult => ({
  ...record,
  actions: record.actions.map((action) => ({ ...action })),
  ...(replayed ? { replayed: true } : {}),
});

const CONTINUATION = {
  ready: "Continue with normal preview tools in this tab.",
  "inspect-first":
    "An action may have taken effect. Take preview_snapshot first; only then change the page, and do not assume repeating the action is safe.",
  unavailable: "The tab is gone. Inspect the site another way before repeating anything.",
} as const;

/** Key order must not make an identical repeat look like a conflict. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

export const makeService = Effect.fn("BrowserTaskService.make")(function* (backend: TaskBackend) {
  const digests = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const fibers = yield* FiberSet.make<void, never>();
  // Admission is synchronous, so an identity is claimed atomically before any effect. A session's
  // journal lasts as long as its credential can return; only a revoked credential drops it.
  const journals = new Map<string, SessionJournal>();

  const sweepRevoked = Effect.gen(function* () {
    for (const [key, journal] of journals) {
      if ((yield* backend.credentialState(journal.providerSessionId)) === "revoked")
        journals.delete(key);
    }
  });

  const run: BrowserTaskService["Service"]["run"] = Effect.fn("BrowserTaskService.run")(function* ({
    scope,
    request,
    authorize,
  }) {
    if (scope.taskBrowser?.backend !== "integrated" || scope.managedBrowser !== true)
      return yield* denied(
        "Bounded browser tasks run on the integrated browser only. No other backend was substituted, and nothing was sent to a provider.",
      );
    const problem = requestProblem(request);
    if (problem !== undefined) return yield* invalid(problem);
    yield* authorize.pipe(Effect.mapError((failure) => denied(failure.message)));

    const digestBytes = yield* digests
      .digest(
        Digest.sha256,
        new TextEncoder().encode(
          canonicalJson({ ...request, limits: resolveLimits(request.limits) }),
        ),
      )
      .pipe(Effect.orDie);
    const digest = Buffer.from(digestBytes).toString("hex");
    const key = Broker.hostAssignmentKey(scope);

    const existing = journals.get(key)?.runs.get(request.requestId);
    if (existing !== undefined) {
      if (existing.digest !== digest)
        return yield* invalid(
          `requestId ${request.requestId} already names a task with different inputs.`,
        );
      return toResult(existing.record, true);
    }

    yield* backend.assertOwnedTab(scope, request.tabId);
    yield* sweepRevoked;

    const cancelled = yield* Deferred.make<void>();
    const reported = yield* Deferred.make<void>();
    const lease = yield* random.uuidV4();
    // Admission, the fork and the interrupt hook form one step, so an interrupt can't strand a run.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const admitted = yield* Effect.sync(() => {
          const journal = journals.get(key) ?? {
            providerSessionId: scope.thread.providerSessionId,
            runs: new Map<string, RunEntry>(),
          };
          const raced = journal.runs.get(request.requestId);
          if (raced !== undefined) return { _tag: "raced", entry: raced } as const;
          if (journal.runs.size >= PREVIEW_TASK_LIMITS.sessionRequests)
            return { _tag: "full" } as const;
          const entry: RunEntry = { digest, record: emptyRecord(request), cancelled, reported };
          journal.runs.set(request.requestId, entry);
          journals.set(key, journal);
          return { _tag: "admitted", entry } as const;
        });
        if (admitted._tag === "full")
          return yield* invalid(
            `This session has used its ${PREVIEW_TASK_LIMITS.sessionRequests} task requests; replay protection is never evicted. Use normal preview tools.`,
          );
        if (admitted._tag === "raced") {
          if (admitted.entry.digest !== digest)
            return yield* invalid(
              `requestId ${request.requestId} already names a task with different inputs.`,
            );
          return toResult(admitted.entry.record, true);
        }

        const { entry } = admitted;
        const port: BrowserTaskPort = {
          ...backend.port(scope, request.tabId, lease),
          authorize: authorize.pipe(
            Effect.andThen(backend.credentialState(scope.thread.providerSessionId)),
            Effect.flatMap((state) =>
              state === "live"
                ? Effect.void
                : Effect.fail({ message: `The task's credential is ${state}.` }),
            ),
          ),
        };

        const setContinuation = (state: keyof typeof CONTINUATION) =>
          Effect.sync(() => {
            (entry.record as { continuation: RunRecord["continuation"] }).continuation = {
              state,
              guidance: CONTINUATION[state],
            };
          });

        const execution = Effect.gen(function* () {
          const outcome = yield* runBrowserTask({
            request,
            record: entry.record,
            port,
            limits: resolveLimits(request.limits),
            cancelled,
          });
          // The lease outlives the report when in-flight work has not quiesced.
          const released = yield* Deferred.make<void>();
          yield* FiberSet.run(
            fibers,
            backend
              .release(scope, request.tabId, lease, {
                leased: outcome.leased,
                inspectFirst: outcome.uncertain,
              })
              .pipe(
                Effect.flatMap((state) =>
                  setContinuation(
                    state === "tab-lost"
                      ? "unavailable"
                      : outcome.uncertain
                        ? "inspect-first"
                        : "ready",
                  ),
                ),
                Effect.ensuring(Deferred.succeed(released, undefined)),
              ),
          );
          yield* Deferred.await(released).pipe(
            Effect.timeoutOrElse({ duration: RELEASE_GRACE_MS, orElse: () => Effect.void }),
          );
          yield* Deferred.succeed(reported, undefined);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("bounded browser task stopped unexpectedly", { cause }).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  const mutable = entry.record as { status: RunRecord["status"]; reason?: string };
                  if (mutable.status === "running") {
                    mutable.status = "blocked";
                    mutable.reason = "internal-error";
                  }
                }),
              ),
              Effect.andThen(Deferred.succeed(reported, undefined)),
              Effect.asVoid,
            ),
          ),
        );
        yield* FiberSet.run(fibers, execution);

        yield* restore(Deferred.await(reported)).pipe(
          // A caller that stops waiting, as a turn interrupt does, stops the run too.
          Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
        );
        return toResult(entry.record, false);
      }),
    );
  });

  const cancel: BrowserTaskService["Service"]["cancel"] = Effect.fn("BrowserTaskService.cancel")(
    function* ({ scope, requestId }) {
      const entry = journals.get(Broker.hostAssignmentKey(scope))?.runs.get(requestId);
      if (entry === undefined)
        return yield* invalid(`No task ${requestId} exists in this session.`);
      yield* Deferred.succeed(entry.cancelled, undefined);
      if (entry.record.status === "running") yield* Deferred.await(entry.reported);
      return toResult(entry.record, true);
    },
  );

  return BrowserTaskService.of({ run, cancel });
});

const failureMessage = (cause: unknown): PortFailure => ({
  message:
    typeof cause === "object" && cause !== null && "message" in cause
      ? String(cause.message)
      : "The browser refused.",
});

export const layer = Layer.effect(
  BrowserTaskService,
  Effect.gen(function* () {
    const broker = yield* Broker.PreviewAutomationBroker;
    const browser = yield* ServerBrowser.ServerBrowser;
    const decisions = yield* DecisionService.DecisionService;
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const saveServices = yield* Effect.context<
      ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
    >();

    const backend: TaskBackend = {
      credentialState: registry.credentialState,
      assertOwnedTab: (scope, tabId) =>
        broker
          .invoke<PreviewAutomationStatus>({
            scope,
            tabId,
            operation: "status",
            input: {},
            updateCurrentTab: false,
          })
          .pipe(
            Effect.mapError((cause) =>
              denied(`${failureMessage(cause).message} ${TAB_UNAVAILABLE_GUIDANCE}`),
            ),
            Effect.flatMap((status) =>
              status.tabId === tabId && status.control?.ownedByCaller === true
                ? Effect.void
                : Effect.fail(denied("Run a task only on a tab you own, from preview_open.")),
            ),
          ),
      port: (scope, tabId, lease) => {
        const lessee = {
          threadId: scope.thread.threadId,
          tabId,
          agentSessionId: Broker.hostAssignmentKey(scope),
          lease,
        };
        // Never the broker's evicting timeout: a run's deadline says nothing about the host's health.
        const invoke = <A>(
          operation: "snapshot" | "click" | "type" | "select" | "scroll" | "navigate",
          input: unknown,
          timeoutMs: number,
        ) =>
          broker.invoke<A>({
            scope,
            tabId,
            operation,
            input,
            timeoutMs,
            updateCurrentTab: false,
            taskLease: lease,
          });
        return {
          acquire: () => browser.acquireTaskLease(lessee),
          snapshot: (timeoutMs) => invoke<PreviewAutomationSnapshot>("snapshot", {}, timeoutMs),
          act: (operation, input, timeoutMs) => invoke<unknown>(operation, input, timeoutMs),
          decide: (input) =>
            decisions.decide(input) as Effect.Effect<
              Effect.Success<ReturnType<typeof decisions.decide>>,
              DecisionError
            >,
          capture: Effect.fn("BrowserTaskService.capture")(
            function* (locator: string, timeoutMs: number) {
              const captured = yield* browser.captureTaskTarget({
                ...lessee,
                locator,
                timeoutMs,
              });
              const png = new Uint8Array(Buffer.from(captured.data, "base64"));
              const path = yield* saveBrowserScreenshot(captured.url, png);
              if (captured.width <= 0 || captured.height <= 0)
                return yield* Effect.fail(failureMessage({ message: "The capture is empty." }));
              return {
                path,
                mimeType: "image/png" as const,
                width: captured.width,
                height: captured.height,
                framing: {
                  kind: "element-crop" as const,
                  targetBox: captured.box,
                  viewport: captured.viewport,
                  url: captured.url,
                  capturedAt: DateTime.formatIso(yield* DateTime.now),
                  centreVisible: captured.centreVisible,
                },
              };
            },
            Effect.provide(saveServices),
            Effect.mapError((cause) => failureMessage(cause)),
          ),
        };
      },
      release: (scope, tabId, lease, { leased, inspectFirst }) => {
        const lessee = {
          threadId: scope.thread.threadId,
          tabId,
          agentSessionId: Broker.hostAssignmentKey(scope),
          lease,
        };
        return leased
          ? browser.releaseTaskLease({ ...lessee, inspectFirst })
          : browser.abandonTaskLease(lessee).pipe(Effect.as("released" as const));
      },
    };
    return yield* makeService(backend);
  }),
);
