import {
  type DecisionError,
  OrchestratorMcpFailure,
  PREVIEW_TASK_LIMITS,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewTabId,
  type PreviewTaskRequest,
  type PreviewTaskResult,
  type PreviewTaskTarget,
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
  plannedScreenshots,
  type PortFailure,
  RECOVERY_KEYS,
  resolveLimits,
  runBrowserTask,
  LOGIN_REFUSED,
  TARGET_NOT_FOCUSABLE,
  type RunRecord,
} from "./BrowserTaskRunner.ts";
import type { NameSpec } from "./pageModel.ts";
import * as BrowserLogins from "../secrets/BrowserLogins.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/** Run IDs live with the server, and a restart ends every tab, so a retry is refused rather than rerun. */
const TAB_UNAVAILABLE_GUIDANCE =
  "If the tab closed or the server restarted, an earlier task on it may still have taken effect: open a new tab, read the page, and only repeat work under a new requestId.";

const CONTROL_LABELS = new Set(["SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"]);
/** Ids the run gives its own screenshot and capture. */
const RESERVED_SCREENSHOT_IDS = new Set(["stopped", "capture"]);
/** Long enough that a finished run reports its released lease; short enough not to hold the caller. */
const RELEASE_GRACE_MS = 500;
/** Scrolling a rendered element into view is quick; a longer wait means it is not rendered. */
const COVER_CHECK_MS = 2_000;

const duplicate = (ids: readonly string[]) => ids.find((id, index) => ids.indexOf(id) !== index);

const nameProblem = (spec: NameSpec) => {
  if (spec.name !== undefined && spec.nameIncludes !== undefined)
    return "give at most one of name or nameIncludes.";
  if (spec.nameIncludes !== undefined && spec.nameIncludes.trim().length === 0)
    return "nameIncludes needs text, not only spaces.";
  return undefined;
};

/** Where a target sits decides which of its forms it may take. */
type TargetUse = "click" | "press" | "submit" | "binding" | "check" | "capture" | "screenshot";

const targetProblem = (target: PreviewTaskTarget, use: TargetUse) => {
  if (target.text !== undefined) {
    if (use !== "click" && use !== "submit" && use !== "check")
      return "a text target is only for clicks, submit and checks.";
    if (target.role !== undefined || target.name !== undefined || target.nameIncludes !== undefined)
      return "give text instead of role and name, not with them.";
    if (target.text.trim().length === 0) return "text needs words, not only spaces.";
  } else if (target.role === undefined) return "give a role, or text.";
  if (target.hint !== undefined) {
    if (use !== "click" && use !== "press" && use !== "submit")
      return "a hint is only for clicks, key presses and submit.";
    if (target.hint.trim().length === 0) return "a hint needs words, not only spaces.";
  }
  if (target.scope?.hint !== undefined) return "a scope takes no hint.";
  if (target.scope?.text !== undefined) return "a scope takes no text.";
  return (
    nameProblem(target) ?? (target.scope === undefined ? undefined : nameProblem(target.scope))
  );
};

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
  const shots = (request.steps ?? []).flatMap((step) => (step.kind === "screenshot" ? [step] : []));
  const shotIds = shots.map((shot) => shot.id);
  const repeatedShot = duplicate([...steps, ...shotIds]);
  if (repeatedShot !== undefined) return `Id ${repeatedShot} is used twice.`;
  const reservedShot = [
    ...shotIds,
    ...actions.flatMap((action) => (action.screenshot === undefined ? [] : [action.id])),
  ].find((id) => CONTROL_LABELS.has(id) || RESERVED_SCREENSHOT_IDS.has(id));
  if (reservedShot !== undefined) return `Screenshot id ${reservedShot} is reserved.`;
  const targets: Array<readonly [string, PreviewTaskTarget, TargetUse]> = [];
  for (const binding of bindings) targets.push([binding.id, binding.target, "binding"]);
  for (const action of actions) {
    if ("press" in action) targets.push([action.id, action.press.target, "press"]);
    else if ("target" in action) targets.push([action.id, action.target, "click"]);
  }
  if (request.submit !== undefined)
    targets.push([request.submit.id, request.submit.target, "submit"]);
  if (request.capture !== undefined) targets.push(["capture", request.capture.target, "capture"]);
  for (const shot of shots)
    if (shot.target !== undefined) targets.push([shot.id, shot.target, "screenshot"]);
  for (const check of request.checks)
    if (check.kind === "target") targets.push([check.id, check.target, "check"]);
  for (const [id, target, use] of targets) {
    const problem = targetProblem(target, use);
    if (problem !== undefined) return `${id}: ${problem}`;
  }
  for (const binding of bindings)
    if (binding.control === "login" && !binding.login.startsWith(BrowserLogins.LOGIN_PREFIX))
      return `${binding.id}: ${binding.login} is not a saved login. Only ${BrowserLogins.LOGIN_PREFIX} keys can be used.`;
  for (const shot of shots)
    if ((shot.framing === "target") !== (shot.target !== undefined))
      return `Screenshot ${shot.id} names a target only with target framing.`;
  if (plannedScreenshots(request) > PREVIEW_TASK_LIMITS.screenshots)
    return `A run may take at most ${PREVIEW_TASK_LIMITS.screenshots} screenshots, counting one where a failed run stops and any capture.`;
  if (request.steps !== undefined) {
    const ordered = request.steps;
    if (ordered.length === 0) return "Name at least one step, or leave steps out for goal mode.";
    if (ordered.length > PREVIEW_TASK_LIMITS.steps)
      return `At most ${PREVIEW_TASK_LIMITS.steps} steps are allowed.`;
    const runs = ordered.flatMap((step) => (step.kind === "run" ? [step.id] : []));
    const unknown = runs.find((id) => !steps.includes(id));
    if (unknown !== undefined) return `Step ${unknown} names no binding, action or submit.`;
    const twice = duplicate(runs);
    if (twice !== undefined) return `Step ${twice} runs at most once.`;
    const unrun = [
      ...bindings.map((binding) => binding.id),
      ...(request.submit === undefined ? [] : [request.submit.id]),
      ...actions.flatMap((action) =>
        "url" in action || ("press" in action && !RECOVERY_KEYS.has(action.press.key))
          ? [action.id]
          : [],
      ),
    ].find((id) => !runs.includes(id));
    if (unrun !== undefined)
      return `${unrun} needs a step: only offered clicks and Escape, Tab or arrow keys may be left for recovery.`;
    if (actions.some((action) => action.screenshot !== undefined))
      return "In ordered mode, take screenshots with screenshot steps.";
    const maxActions = resolveLimits(request.limits).maxActions;
    if (runs.length > maxActions)
      return `The steps need ${runs.length} actions; raise maxActions to at least that.`;
  }
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
  /** Read afresh for each admitted run; refused before any browser effect. */
  readonly readLogin: (
    key: string,
  ) => Effect.Effect<BrowserLogins.Login, BrowserLogins.BrowserLoginRefused>;
  /** Hands the value to the tab's host, the only place it is kept. */
  readonly holdLogin: (
    scope: McpThreadInvocationScope,
    tabId: PreviewTabId,
    login: BrowserLogins.Login,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
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

/** A bounded-only caller has no step-by-step preview tools, so its guidance names its own. */
const CONTINUATION = {
  preview: {
    ready: "Continue with normal preview tools in this tab.",
    "inspect-first":
      "An action may have taken effect. Take preview_snapshot first; only then change the page, and do not assume repeating the action is safe.",
    unavailable: "The tab is gone. Inspect the site another way before repeating anything.",
  },
  bounded: {
    ready:
      "The tab is yours: send another bounded t3_browser_task, take t3_browser_snapshot, or t3_browser_close it.",
    "inspect-first":
      "An action may have taken effect. Take t3_browser_snapshot first; send a new bounded request only after reading the page, and do not assume repeating the action is safe.",
    unavailable:
      "The tab is gone. Open a new tab with t3_browser_open and read the page before repeating anything.",
  },
} as const;
const lane = (scope: McpThreadInvocationScope) =>
  scope.browserLane === "bounded" ? ("bounded" as const) : ("preview" as const);

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
    const loginKeys = new Set(
      (request.bindings ?? []).flatMap((binding) =>
        binding.control === "login" ? [binding.login] : [],
      ),
    );
    for (const key of loginKeys) {
      const login = yield* backend
        .readLogin(key)
        .pipe(
          Effect.mapError((refused) =>
            refused.reason === "not-configured" || refused.reason === "unreachable"
              ? denied(refused.message)
              : invalid(refused.message),
          ),
        );
      yield* backend.holdLogin(scope, request.tabId, login);
    }

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
            `This session has used its ${PREVIEW_TASK_LIMITS.sessionRequests} task requests; replay protection is never evicted. ${lane(scope) === "bounded" ? "No further bounded tasks run in this session." : "Use normal preview tools."}`,
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

        const setContinuation = (state: keyof (typeof CONTINUATION)["preview"]) =>
          Effect.sync(() => {
            (entry.record as { continuation: RunRecord["continuation"] }).continuation = {
              state,
              guidance: CONTINUATION[lane(scope)][state],
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
  // The host's own tag, such as a refused screenshot's, decides how the run reports it.
  ...(typeof cause === "object" && cause !== null && "tag" in cause && typeof cause.tag === "string"
    ? { _tag: cause.tag }
    : {}),
});

const LOGIN_REFUSALS = {
  origin: (key: string) =>
    `Login ${key} is not bound to this page's origin, or to its frame's; nothing was typed.`,
  "not-password": (key: string) =>
    `The target is not a password field, so login ${key} was not typed.`,
  "not-focused": (key: string) =>
    `The password field did not hold focus, so login ${key} was not typed.`,
} as const;

export const layer = Layer.effect(
  BrowserTaskService,
  Effect.gen(function* () {
    const broker = yield* Broker.PreviewAutomationBroker;
    const browser = yield* ServerBrowser.ServerBrowser;
    const decisions = yield* DecisionService.DecisionService;
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const logins = yield* BrowserLogins.BrowserLogins;
    const saveServices = yield* Effect.context<
      ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
    >();

    const backend: TaskBackend = {
      credentialState: registry.credentialState,
      readLogin: logins.read,
      holdLogin: (scope, tabId, login) =>
        browser
          .holdTaskLogin({
            threadId: scope.thread.threadId,
            tabId,
            agentSessionId: Broker.hostAssignmentKey(scope),
            key: login.key,
            value: login.value,
            origins: login.origins,
          })
          .pipe(Effect.mapError((error) => denied(error.message))),
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
                : Effect.fail(
                    denied(
                      `Run a task only on a tab you own, from ${scope.browserLane === "bounded" ? "t3_browser_open" : "preview_open"}.`,
                    ),
                  ),
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
          loginApplied: ({ locator, login }, timeoutMs) =>
            browser
              .taskLoginApplied({ ...lessee, locator, key: login, timeoutMs })
              .pipe(Effect.mapError(failureMessage)),
          clearLogins: (timeoutMs) =>
            browser.clearTaskLogins({ ...lessee, timeoutMs }).pipe(Effect.mapError(failureMessage)),
          act: (operation, input, timeoutMs) =>
            operation === "login"
              ? browser
                  .fillTaskLogin({
                    ...lessee,
                    locator: String(input.locator),
                    key: String(input.login),
                    timeoutMs,
                  })
                  .pipe(
                    Effect.mapError(failureMessage),
                    Effect.flatMap((outcome) =>
                      outcome === "filled"
                        ? Effect.void
                        : Effect.fail(
                            outcome === "stale"
                              ? {
                                  _tag: "PreviewAutomationInvalidSelectorError",
                                  message:
                                    "The target is gone or ambiguous, so the login was not typed.",
                                }
                              : {
                                  _tag: LOGIN_REFUSED,
                                  message: LOGIN_REFUSALS[outcome](String(input.login)),
                                },
                          ),
                    ),
                  )
              : operation === "press"
                ? browser
                    .pressTaskTarget({
                      ...lessee,
                      locator: String(input.locator),
                      key: String(input.key),
                      timeoutMs,
                    })
                    .pipe(
                      Effect.mapError(failureMessage),
                      Effect.flatMap((outcome) =>
                        outcome === "pressed"
                          ? Effect.void
                          : Effect.fail(
                              outcome === "stale"
                                ? {
                                    _tag: "PreviewAutomationInvalidSelectorError",
                                    message:
                                      "The target is gone or ambiguous, so the key was not pressed.",
                                  }
                                : {
                                    _tag: TARGET_NOT_FOCUSABLE,
                                    message:
                                      "The target did not hold focus, so the key was not pressed.",
                                  },
                            ),
                      ),
                    )
                : invoke<unknown>(operation, input, timeoutMs),
          settle: (timeoutMs) =>
            browser.settleTask({ ...lessee, timeoutMs }).pipe(Effect.mapError(failureMessage)),
          covered: (locator, timeoutMs) =>
            browser
              .taskTargetCovered({
                ...lessee,
                locator,
                timeoutMs: Math.min(timeoutMs, COVER_CHECK_MS),
              })
              .pipe(Effect.mapError(failureMessage)),
          screenshot: Effect.fn("BrowserTaskService.screenshot")(
            function* ({ framing, locator, maxBytes }, timeoutMs: number) {
              const taken = yield* browser.captureTaskScreenshot({
                ...lessee,
                framing,
                locator,
                maxBytes,
                timeoutMs,
              });
              if (taken.width <= 0 || taken.height <= 0 || taken.data.length === 0)
                return yield* Effect.fail(failureMessage({ message: "The screenshot is empty." }));
              const path = yield* saveBrowserScreenshot(
                taken.url,
                new Uint8Array(taken.data),
                taken.mimeType === "image/png" ? "png" : "jpg",
              );
              return {
                path,
                mimeType: taken.mimeType,
                width: taken.width,
                height: taken.height,
                bytes: taken.data.length,
                cut: taken.cut,
                url: taken.url,
                title: taken.title,
                capturedAt: DateTime.formatIso(yield* DateTime.now),
              };
            },
            Effect.provide(saveServices),
            Effect.mapError((cause) => failureMessage(cause)),
          ),
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
