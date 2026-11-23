import {
  OrchestratorMcpFailure,
  PREVIEW_RECORDING_STOP_TIMEOUT_MS,
  PreviewAutomationActInputs,
  PreviewAutomationDialogInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationResizeInput,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationWaitForInput,
  type PreviewAutomationOperation,
  type PreviewAutomationSnapshot,
  type PreviewAutomationSnapshotMetadata,
  type PreviewAutomationStatus,
  type PreviewTabId,
  type ToolActivityIcon,
  usesPhi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as BrowserTaskCalls from "../../../browserTasks/BrowserTaskCalls.ts";
import * as BrowserTaskService from "../../../browserTasks/BrowserTaskService.ts";
import type * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as BrowserLogins from "../../../secrets/BrowserLogins.ts";
import { assertBoundedBrowserCaller } from "../../ManagedBrowserAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { unavailable } from "../../threadAccess.ts";
import { claimPreviewRecording, invoke, normalizePreviewOpenInput } from "../preview/handlers.ts";
import {
  type BrowserActAction,
  type BrowserActStep,
  BrowserSnapshotToolkit,
  BrowserToolkit,
} from "./tools.ts";

/**
 * Where a call goes, from the credential, never the agent: `bounded` (fresh headless tabs only
 * this session uses, which `browser_task` drives), `managed` (a Phi browser task's own browser)
 * or `shared` (the thread's browser shared with the user: its panel, Phi and saved profiles).
 */
type BrowserLane = "bounded" | "managed" | "shared";

const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/**
 * The tabs an editor opened in its bounded lane. A tab's lane is a fact about the tab, so one
 * set serves every endpoint; a restart loses the tabs with it. Bounded so it cannot grow.
 */
const boundedTabs = new Set<string>();
const MAX_BOUNDED_TABS = 4096;
const rememberBoundedTab = (tabId: string | null) => {
  if (tabId === null) return;
  boundedTabs.add(tabId);
  for (const oldest of boundedTabs) {
    if (boundedTabs.size <= MAX_BOUNDED_TABS) break;
    boundedTabs.delete(oldest);
  }
};

/**
 * The tab each editor session opened last, on either lane: a call without a `tabId` means it, so
 * a headless open after a Phi one is not shadowed by the shared lane's current tab.
 */
const lastOpened = new Map<string, PreviewTabId>();
const sessionKey = (scope: McpInvocationContext.McpInvocationScope) =>
  scope.thread === undefined
    ? undefined
    : McpInvocationContext.browserOwnerKey({
        environmentId: scope.environmentId,
        thread: scope.thread,
      });
const rememberOpened = (
  scope: McpInvocationContext.McpInvocationScope,
  tabId: PreviewTabId | null,
) => {
  const key = sessionKey(scope);
  if (key === undefined || tabId === null) return;
  lastOpened.delete(key);
  lastOpened.set(key, tabId);
  for (const oldest of lastOpened.keys()) {
    if (lastOpened.size <= MAX_BOUNDED_TABS) break;
    lastOpened.delete(oldest);
  }
};

const pinnedBackend = (scope: McpInvocationContext.McpInvocationScope) =>
  scope.taskBrowser?.backend ?? "integrated";

/** The lane a call on `tabId` (or on the session's current tab) goes to. */
const browserLane = (
  scope: McpInvocationContext.McpInvocationScope,
  tabId?: string,
): BrowserLane => {
  if (scope.managedBrowser === true)
    return pinnedBackend(scope) === "integrated" && scope.boundedBrowser === true
      ? "bounded"
      : "managed";
  if (scope.boundedBrowser !== true || scope.endpointKey === "preview") return "shared";
  if (scope.endpointKey === "reader") return "bounded";
  return tabId !== undefined && boundedTabs.has(tabId) ? "bounded" : "shared";
};

/** The lane and tab a call goes to: an omitted `tabId` on an editor means the tab it opened last. */
const browserTarget = (
  scope: McpInvocationContext.McpInvocationScope,
  requested?: PreviewTabId,
): { readonly lane: BrowserLane; readonly tabId: PreviewTabId | undefined } => {
  const remembered =
    requested === undefined && scope.endpointKey === "editor" && scope.boundedBrowser === true
      ? lastOpened.get(sessionKey(scope) ?? "")
      : undefined;
  const tabId =
    requested ?? (remembered !== undefined && boundedTabs.has(remembered) ? remembered : undefined);
  return { lane: browserLane(scope, tabId), tabId };
};

const openLane = (
  scope: McpInvocationContext.McpInvocationScope,
  input: {
    readonly backend?: "headless" | "phi";
    readonly show?: boolean;
    readonly profileId?: string;
    readonly phiLane?: string;
  },
): Effect.Effect<BrowserLane, OrchestratorMcpFailure> => {
  const wantsShared =
    input.backend === "phi" || input.show === true || input.profileId !== undefined;
  if (scope.managedBrowser === true) {
    const pinned = pinnedBackend(scope);
    if (input.backend !== undefined && (input.backend === "phi") !== (pinned === "phi"))
      return Effect.fail(
        refuse(
          `This task's browser is ${pinned === "phi" ? "Phi" : "headless"}; the task chose it when it was delegated.`,
        ),
      );
    if (input.show === true || input.profileId !== undefined)
      return Effect.fail(refuse("A browser task opens its own tabs, with no panel or profile."));
    const lane = scope.taskBrowser?.phiLane ?? "shadow";
    if (pinned === "phi" && input.phiLane !== undefined && input.phiLane !== lane)
      return Effect.fail(
        refuse(
          `This task's Phi lane is ${lane}; the task chose it when it was delegated. Omit phiLane.`,
        ),
      );
    return Effect.succeed(browserLane(scope));
  }
  if (scope.endpointKey === "preview") return Effect.succeed("shared");
  if (scope.endpointKey === "reader") {
    return wantsShared
      ? Effect.fail(
          refuse(
            "This session's browser is headless only. Phi, the thread's browser panel and saved profiles need a browser task.",
          ),
        )
      : Effect.succeed("bounded");
  }
  return Effect.succeed(!wantsShared && scope.boundedBrowser === true ? "bounded" : "shared");
};

interface Invocation {
  readonly operation: PreviewAutomationOperation;
  readonly input: { readonly [key: string]: unknown };
  readonly tabId?: PreviewTabId | undefined;
  readonly timeoutMs?: number | undefined;
}

type Invoked = { readonly result: unknown; readonly toolIcon?: ToolActivityIcon };

const invoking = (call: Invocation) =>
  invoke<unknown>(call.operation, call.input, call.timeoutMs, call.tabId) as Effect.Effect<
    Invoked,
    import("@t3tools/contracts").PreviewAutomationError,
    McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
  >;

/** What a step needs on the shared lane, where it follows the matching `preview_*` tool's rule. */
type Access = "read" | "act" | "write";

const SHARED_ACCESS: Record<BrowserActAction, Access> = {
  navigate: "act",
  click: "act",
  type: "act",
  press: "act",
  hover: "act",
  select: "act",
  drag: "act",
  scroll: "act",
  resize: "act",
  wait: "read",
  appearance: "write",
  upload: "write",
  dialog: "write",
  evaluate: "write",
};

const OPERATION: Record<BrowserActAction, PreviewAutomationOperation> = {
  navigate: "navigate",
  click: "click",
  type: "type",
  press: "press",
  hover: "hover",
  select: "select",
  drag: "drag",
  scroll: "scroll",
  resize: "resize",
  wait: "waitFor",
  appearance: "setColorScheme",
  upload: "upload",
  dialog: "dialog",
  evaluate: "evaluate",
};

const STEP_INPUT = {
  ...PreviewAutomationActInputs,
  navigate: PreviewAutomationNavigateInput,
  wait: PreviewAutomationWaitForInput,
  resize: PreviewAutomationResizeInput,
  appearance: PreviewAutomationSetColorSchemeInput,
  dialog: PreviewAutomationDialogInput,
  evaluate: PreviewAutomationEvaluateInput,
} satisfies Record<BrowserActAction, Schema.Top>;

const decodeStep = Object.fromEntries(
  Object.entries(STEP_INPUT).map(([action, schema]) => [
    action,
    Schema.decodeUnknownEffect(schema as Schema.Codec<object, unknown>),
  ]),
) as Record<
  BrowserActAction,
  (input: unknown, options?: object) => Effect.Effect<object, Schema.SchemaError>
>;

/** Headless tabs and browser tasks never run page code, uploads or dialogs. */
const CONFINED_ACTIONS: ReadonlySet<BrowserActAction> = new Set(["upload", "dialog", "evaluate"]);
/** A browser agent on the shared lane also leaves the page's appearance alone, as before. */
const BROWSER_AGENT_ACTIONS: ReadonlySet<BrowserActAction> = new Set([
  ...CONFINED_ACTIONS,
  "appearance",
]);

const MAX_STEPS = 25;
/** Implementers and reviewers check their work with short flows; long ones belong in a script. */
const MAX_CHECKING_STEPS = 10;

const browserActStepLimit = (scope: McpInvocationContext.McpInvocationScope) =>
  scope.agentRole === "implementer" || scope.agentRole === "reviewer"
    ? MAX_CHECKING_STEPS
    : MAX_STEPS;

/** The actions a lane refuses, before any step of a call runs. */
const refusedActions = (
  scope: McpInvocationContext.McpInvocationScope,
  lane: BrowserLane,
): ReadonlySet<BrowserActAction> =>
  lane !== "shared"
    ? CONFINED_ACTIONS
    : usesPhi(scope.toolProfile)
      ? BROWSER_AGENT_ACTIONS
      : new Set();

const stepInput = (step: BrowserActStep) => {
  const { action, timeoutMs, ...fields } = step;
  const schema = STEP_INPUT[action] as { readonly fields?: Record<string, unknown> };
  return {
    action,
    timeoutMs,
    input:
      timeoutMs !== undefined && schema.fields !== undefined && "timeoutMs" in schema.fields
        ? { ...fields, timeoutMs }
        : fields,
  };
};

const stepResult = (action: BrowserActAction, invoked: Invoked) =>
  action === "evaluate"
    ? { action, value: invoked.result ?? null }
    : {
        action,
        ...(typeof invoked.result === "object" && invoked.result !== null ? invoked.result : {}),
      };

const errorOf = (error: unknown) => ({
  error:
    typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
      ? error._tag
      : "Error",
  message:
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "The step failed.",
});

const make = Effect.gen(function* () {
  const logins = yield* BrowserLogins.BrowserLogins;
  const calls = yield* Effect.serviceOption(BrowserTaskCalls.BrowserTaskCalls);
  const withLogins = BrowserLogins.withLoginKeys(logins);

  // Each lane's checks are those of the tools it replaces; a call runs them before acting.
  const lanes = {
    bounded: {
      read: McpToolAccess.asBoundedBrowser(invoking),
      act: McpToolAccess.asBoundedBrowser(invoking),
      write: McpToolAccess.asBoundedBrowser(invoking),
      close: McpToolAccess.cleansUpAsBoundedBrowser(({ tabId }: { readonly tabId: PreviewTabId }) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
          const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
          // Revoking access or expiry may already have closed it; a tab that is gone is closed.
          yield* broker
            .close({ scope, tabId })
            .pipe(
              Effect.catchTags({ PreviewAutomationTabNotFoundError: () => Effect.void }),
              Effect.mapError(unavailable),
            );
          return {};
        }),
      ),
      list: undefined,
    },
    managed: {
      read: McpToolAccess.asManagedBrowser(invoking),
      act: McpToolAccess.asManagedBrowser(invoking),
      write: McpToolAccess.asManagedBrowser(invoking),
      close: McpToolAccess.cleansUpAsManagedBrowser(({ tabId }: { readonly tabId: PreviewTabId }) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
          const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
          yield* broker.close({ scope, tabId }).pipe(Effect.mapError(unavailable));
          return {};
        }),
      ),
      list: McpToolAccess.asManagedBrowser(
        (input: { readonly cursor?: number | undefined; readonly limit?: number | undefined }) =>
          Effect.gen(function* () {
            const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
            const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
            return yield* broker.list({ scope, ...input }).pipe(Effect.mapError(unavailable));
          }),
      ),
    },
    shared: {
      read: McpToolAccess.readsAsPreviewCaller(invoking),
      act: McpToolAccess.actsAsPreviewCaller(invoking),
      write: McpToolAccess.actsAsCaller(invoking),
      close: McpToolAccess.cleansUpAsPreviewCaller(({ tabId }: { readonly tabId: PreviewTabId }) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
          const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
          // A browser backend's refusal says why; a preview manager failure does not.
          yield* broker.close({ scope, tabId }).pipe(
            Effect.catchTags({
              PreviewSessionLookupError: () => Effect.fail(unavailable()),
              PreviewInvalidUrlError: () => Effect.fail(unavailable()),
              PreviewControlRequiredError: () => Effect.fail(unavailable()),
            }),
          );
          return {};
        }),
      ),
      list: McpToolAccess.readsAsPreviewCaller(
        (input: { readonly cursor?: number | undefined; readonly limit?: number | undefined }) =>
          Effect.gen(function* () {
            const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
            const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
            return yield* broker.list({ scope, ...input }).pipe(Effect.mapError(unavailable));
          }),
      ),
    },
  };

  const cancelTask = McpToolAccess.cleansUpAsBoundedBrowser(
    ({ requestId }: { readonly requestId: string }) =>
      Effect.gen(function* () {
        const caller = yield* McpInvocationContext.requireThreadScope(
          yield* McpInvocationContext.McpInvocationContext,
          "A bounded browser task",
        );
        const tasks = yield* BrowserTaskService.BrowserTaskService;
        return yield* tasks.cancel({ scope: caller, requestId });
      }),
  );

  const status = (lane: BrowserLane, run: McpToolAccess.RunDeclaration, tabId?: PreviewTabId) => {
    const page = run(lanes[lane].read, { operation: "status", input: {}, tabId }).pipe(
      Effect.map(({ result }) => result as PreviewAutomationStatus),
    );
    return lane === "shared" ? page : page.pipe(Effect.flatMap(withLogins));
  };

  return {
    browser_open: McpToolAccess.composed(
      ({ target, backend, show, viewport, url, phiLane, profileId, persona }, run) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const lane = yield* openLane(scope, {
            ...(backend === undefined ? {} : { backend }),
            ...(show === undefined ? {} : { show }),
            ...(profileId === undefined ? {} : { profileId }),
            ...(phiLane === undefined ? {} : { phiLane }),
          });
          const phi =
            (lane === "managed" && pinnedBackend(scope) === "phi") ||
            (lane === "shared" &&
              (backend === "phi" ||
                phiLane !== undefined ||
                (backend === undefined && scope.browserBackends?.default === "phi")));
          if (phi && persona !== undefined)
            return yield* refuse("persona applies only to managed headless tabs, not Phi.");
          const size =
            viewport === undefined ? {} : { viewport: { _tag: "freeform" as const, ...viewport } };
          // The Phi user lane takes over the user's selected tab unless it opens a page.
          const takesOver = phiLane === "user" && url === undefined;
          const input =
            lane === "bounded"
              ? {
                  ...(url === undefined ? {} : { url }),
                  ...size,
                  open: false,
                  show: false,
                  reuseExistingTab: false,
                }
              : normalizePreviewOpenInput({
                  ...(url === undefined ? {} : { url }),
                  ...size,
                  ...(lane === "shared" && backend !== undefined
                    ? { backend: backend === "phi" ? ("phi" as const) : ("integrated" as const) }
                    : {}),
                  ...(phiLane === undefined ? {} : { phiLane }),
                  ...(profileId === undefined ? {} : { profileId }),
                  ...(show === true ? { open: true } : takesOver ? {} : { open: false }),
                  ...(takesOver ? {} : { reuseExistingTab: false }),
                });
          const opened = (yield* run(lanes[lane].act, {
            operation: "open",
            input: { ...input, ...(persona === undefined ? {} : { persona }) },
          })).result as PreviewAutomationStatus;
          if (lane === "bounded" && scope.endpointKey === "editor")
            rememberBoundedTab(opened.tabId);
          if (scope.endpointKey === "editor") rememberOpened(scope, opened.tabId);
          const page =
            target === undefined || opened.tabId === null
              ? opened
              : ((yield* run(lanes[lane].act, {
                  operation: "navigate",
                  input: { target },
                  tabId: opened.tabId,
                })).result as PreviewAutomationStatus);
          return lane === "shared" ? page : yield* withLogins(page);
        }),
    ),
    browser_status: McpToolAccess.composed(
      ({ tabId: requested, list, cursor, limit, recording }, run) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const { lane, tabId } = browserTarget(scope, requested);
          if (recording === "start")
            return (yield* run(lanes[lane].write, {
              operation: "recordingStart",
              input: {},
              tabId,
            })).result as never;
          if (recording === "stop") {
            const thread = yield* McpInvocationContext.requireThreadScope(scope, "Recording");
            const response = yield* run(lanes[lane].write, {
              operation: "recordingStop",
              input: { transferToEnvironment: true },
              tabId,
              timeoutMs: PREVIEW_RECORDING_STOP_TIMEOUT_MS,
            });
            return yield* claimPreviewRecording(thread.thread.threadId, response.result);
          }
          if (list === true) {
            // The panel's tabs belong to no tab, so the last-opened tab does not pick the lane.
            const lister = lanes[browserLane(scope, requested)].list;
            if (lister === undefined)
              return yield* refuse(
                "list covers the thread's browser panel; pass a headless tab's tabId.",
              );
            return yield* run(lister, {
              ...(cursor === undefined ? {} : { cursor }),
              ...(limit === undefined ? {} : { limit }),
            });
          }
          return yield* status(lane, run, tabId);
        }),
    ),
    browser_act: McpToolAccess.composed(({ tabId: requested, steps }, run) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const { lane, tabId: target } = browserTarget(scope, requested);
        const limit = browserActStepLimit(scope);
        if (steps.length > limit)
          return yield* refuse(
            `A browser_act call takes at most ${limit} steps here; split the flow, or script it with \`t3 browser run\`.`,
          );
        const refused = refusedActions(scope, lane);
        const blocked = steps.find((step) => refused.has(step.action));
        if (blocked !== undefined)
          return yield* refuse(
            `${blocked.action} is not available on this ${lane === "shared" ? "browser agent's" : "headless or task"} browser; nothing ran.`,
          );
        // Resolved once, so a tab opened mid-batch never takes the later steps.
        const tabId =
          target ??
          (
            (yield* run(lanes[lane].read, { operation: "status", input: {} })).result as {
              readonly tabId: PreviewTabId | null;
            }
          ).tabId;
        if (tabId === null) return yield* refuse("No tab is open; browser_open one first.");
        const results: Array<unknown> = [];
        let toolIcon: ToolActivityIcon | undefined;
        for (const [index, step] of steps.entries()) {
          const { action, timeoutMs, input } = stepInput(step);
          const outcome = yield* decodeStep[action](
            { ...input, tabId },
            { onExcessProperty: "error" },
          ).pipe(
            Effect.mapError((cause) => ({ _tag: "invalid_request", message: cause.message })),
            Effect.flatMap((decoded) => {
              const { tabId: target, ...operationInput } = decoded as {
                readonly tabId?: PreviewTabId;
              };
              const access = lane === "shared" ? SHARED_ACCESS[action] : "act";
              return run(lanes[lane][access], {
                operation: OPERATION[action],
                input: operationInput,
                tabId: target,
                timeoutMs,
              });
            }),
            Effect.result,
          );
          if (outcome._tag === "Failure")
            return {
              tabId,
              completed: index,
              results,
              ...(toolIcon === undefined ? {} : { toolIcon }),
              failed: { step: index, action, ...errorOf(outcome.failure) },
            };
          if (outcome.success.toolIcon !== undefined) toolIcon = outcome.success.toolIcon;
          results.push(stepResult(action, outcome.success));
        }
        return {
          tabId,
          completed: steps.length,
          results,
          ...(toolIcon === undefined ? {} : { toolIcon }),
        };
      }),
    ),
    browser_task: McpToolAccess.asRecordedBoundedTask(calls, (request) =>
      Effect.gen(function* () {
        const invocation = yield* McpInvocationContext.McpInvocationContext;
        const caller = yield* McpInvocationContext.requireThreadScope(
          invocation,
          "A bounded browser task",
        );
        const tasks = yield* BrowserTaskService.BrowserTaskService;
        const services = yield* Effect.context<
          | McpInvocationContext.McpInvocationContext
          | ThreadManagementService.ThreadManagementService
        >();
        // Rechecked before each provider call and dispatch. It grants this job's Jev calls only,
        // never `t3_decide`, so a reviewer gains no general decision access.
        const authorize = assertBoundedBrowserCaller({ checkSettings: true }).pipe(
          Effect.asVoid,
          Effect.provide(services),
        );
        return yield* tasks.run({ scope: caller, request, authorize });
      }),
    ),
    browser_handoff: McpToolAccess.composed(({ tabId: requested, message, resume }, run) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const { lane, tabId } = browserTarget(scope, requested);
        if (lane === "bounded")
          return yield* refuse("A headless tab cannot be handed to the user.");
        if (resume !== true && message === undefined)
          return yield* refuse("Say in message what the user should do, or pass resume:true.");
        const { result } = yield* run(lanes[lane].act, {
          operation: resume === true ? "resume" : "handoff",
          input: resume === true ? {} : { message },
          tabId,
        });
        return result as object;
      }),
    ),
    browser_close: McpToolAccess.composed(({ tabId, requestId }, run) =>
      Effect.gen(function* () {
        if ((tabId === undefined) === (requestId === undefined))
          return yield* refuse("Pass a tabId to close a tab, or a requestId to stop its task.");
        if (requestId !== undefined) return yield* run(cancelTask, { requestId });
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const lane = browserLane(scope, tabId);
        const closed = yield* run(lanes[lane].close, { tabId: tabId! });
        boundedTabs.delete(tabId!);
        return closed;
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof BrowserToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(BrowserToolkit, make);

export const layerSnapshot = McpToolAccess.toLayer(
  BrowserSnapshotToolkit,
  Effect.sync(() => {
    const read = {
      bounded: McpToolAccess.asBoundedBrowser(invoking),
      managed: McpToolAccess.asManagedBrowser(invoking),
      shared: McpToolAccess.readsAsPreviewCaller(invoking),
    };
    return {
      browser_snapshot: McpToolAccess.composed(({ includeImage, save, ...input }, run) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const { tabId: requested, ...operationInput } = input;
          const { lane, tabId } = browserTarget(scope, requested);
          // The saved file is for people, so it keeps the resolution the agent's image is capped below.
          const { result } = yield* run(read[lane], {
            operation: "snapshot",
            input: {
              ...operationInput,
              ...(save === true ? { fullScreenshot: true } : {}),
              ...(includeImage === true || save === true ? {} : { pixelsRequired: false }),
            },
            tabId,
          });
          return result as PreviewAutomationSnapshot | PreviewAutomationSnapshotMetadata;
        }),
      ),
    } satisfies McpToolAccess.Handlers<typeof BrowserSnapshotToolkit.tools>;
  }),
);
