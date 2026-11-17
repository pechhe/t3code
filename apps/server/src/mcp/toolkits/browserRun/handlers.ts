import {
  OrchestratorMcpFailure,
  PREVIEW_RECORDING_STOP_TIMEOUT_MS,
  PreviewAutomationActInputs,
  type PreviewAutomationRecordingArtifact,
  type PreviewAutomationRecordingStatus,
  type PreviewAutomationResizeResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

import { openingRun } from "../../../browserRuns/BrowserRunAccess.ts";
import * as BrowserRuns from "../../../browserRuns/BrowserRuns.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ServerBrowser from "../../../preview/ServerBrowser.ts";
import * as BrowserLogins from "../../../secrets/BrowserLogins.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { unavailable } from "../../threadAccess.ts";
import { invoke, invokeTargeted } from "../preview/handlers.ts";
import { BrowserRunSnapshotToolkit, BrowserRunToolkit } from "./tools.ts";

const decodeActInput = Record.map(PreviewAutomationActInputs, (schema) =>
  Schema.decodeUnknownEffect(schema),
);

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/** The run scope a handler acts with, which `McpToolAccess.inBrowserRun` provided. */
const runScope = McpInvocationContext.requireThreadMcpCapability("preview");

export const layer = McpToolAccess.toLayer(
  BrowserRunToolkit,
  Effect.gen(function* () {
    const logins = yield* BrowserLogins.BrowserLogins;
    const browser = yield* ServerBrowser.ServerBrowser;
    const random = yield* SecureRandom.SecureRandom;
    const runs = yield* BrowserRuns.BrowserRuns;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const path = yield* Path.Path;
    const inRun = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
      McpToolAccess.inBrowserRun(runs, handle);
    return {
      t3_browser_run_open: McpToolAccess.managesBrowserRun(
        ({ timeLimitSeconds, outputLimitBytes, workspace }) =>
          Effect.gen(function* () {
            const access = yield* openingRun({ runs, projects, path }, workspace);
            const run = yield* runs.open({ ...access, timeLimitSeconds, outputLimitBytes });
            return {
              runId: run.runId,
              deadline: DateTime.formatIso(DateTime.makeUnsafe(run.deadline)),
              outputLimitBytes: run.outputLimitBytes,
            };
          }),
      ),
      t3_browser_run_close: McpToolAccess.managesBrowserRun(({ outcome }) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          return yield* runs.close(scope, scope.browserRunId, outcome ?? "succeeded");
        }),
      ),
      t3_browser_run_init_script: inRun(({ script }) =>
        Effect.gen(function* () {
          const scope = yield* runScope;
          yield* browser
            .addRunInitScript({
              agentSessionId: PreviewAutomationBroker.hostAssignmentKey(scope),
              script,
            })
            .pipe(Effect.mapError((error) => denied(error.message)));
          return {};
        }),
      ),
      t3_browser_login: inRun(({ tabId, key, locator }) =>
        Effect.gen(function* () {
          const scope = yield* runScope;
          const login = yield* logins
            .read(key)
            .pipe(Effect.mapError((error) => denied(error.message)));
          const owner = {
            threadId: scope.thread.threadId,
            tabId,
            agentSessionId: PreviewAutomationBroker.hostAssignmentKey(scope),
          };
          yield* browser
            .holdTaskLogin({ ...owner, key: login.key, value: login.value, origins: login.origins })
            .pipe(Effect.mapError((error) => denied(error.message)));
          const lessee = { ...owner, lease: yield* random.uuidV4() };
          yield* browser
            .acquireTaskLease(lessee)
            .pipe(Effect.mapError((error) => denied(error.message)));
          const outcome = yield* browser
            .fillTaskLogin({ ...lessee, locator, key: login.key, timeoutMs: 15_000 })
            .pipe(
              Effect.mapError((error) => denied(error.message)),
              Effect.ensuring(browser.releaseTaskLease({ ...lessee, inspectFirst: false })),
            );
          return { outcome };
        }),
      ),
      t3_browser_run_tabs: McpToolAccess.inBrowserRun(runs, () =>
        Effect.gen(function* () {
          return { tabs: yield* runs.tabs(yield* runScope) };
        }),
      ),
      t3_browser_close: McpToolAccess.cleansUpInBrowserRun(runs, ({ tabId }) =>
        Effect.gen(function* () {
          const scope = yield* runScope;
          const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
          yield* broker
            .close({ scope, tabId })
            .pipe(
              Effect.catchTags({ PreviewAutomationTabNotFoundError: () => Effect.void }),
              Effect.mapError(unavailable),
            );
          return {};
        }),
      ),
      // Every open is a new headless tab in the run's own context; the run closes it at the end.
      preview_open: inRun(({ target, url, profileId: _profileId, ...input }) =>
        Effect.gen(function* () {
          const scope = yield* runScope;
          const opened = yield* invokeTargeted<PreviewAutomationStatus>("open", {
            ...input,
            ...(url === undefined || target !== undefined ? {} : { url }),
            open: false,
            show: false,
            reuseExistingTab: false,
          });
          if (opened.tabId !== null) yield* runs.noteTab(scope.browserRunId ?? "", opened.tabId);
          if (target === undefined || opened.tabId === null) return opened;
          return yield* invokeTargeted<PreviewAutomationStatus>("navigate", {
            target,
            tabId: opened.tabId,
          });
        }),
      ),
      preview_status: inRun((input) =>
        invokeTargeted<PreviewAutomationStatus>("status", input ?? {}),
      ),
      preview_navigate: inRun((input) =>
        invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
      ),
      preview_resize: inRun((input) =>
        invokeTargeted<PreviewAutomationResizeResult>("resize", input, input.timeoutMs),
      ),
      preview_interact: inRun(({ action, ...input }) =>
        decodeActInput[action](input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: cause.message }),
          ),
          Effect.flatMap((decoded) =>
            invokeTargeted<object>(
              action,
              decoded,
              "timeoutMs" in decoded ? decoded.timeoutMs : undefined,
            ),
          ),
        ),
      ),
      preview_upload: inRun((input) => invokeTargeted<object>("upload", input, input.timeoutMs)),
      preview_evaluate: inRun(({ tabId, ...input }) =>
        invoke<unknown>("evaluate", input, undefined, tabId).pipe(
          Effect.map(({ result, toolIcon }) => ({
            value: result ?? null,
            ...(toolIcon ? { toolIcon } : {}),
          })),
        ),
      ),
      preview_wait_for: inRun((input) => invokeTargeted<object>("waitFor", input, input.timeoutMs)),
      preview_recording_start: inRun((input) =>
        invokeTargeted<PreviewAutomationRecordingStatus>("recordingStart", input ?? {}),
      ),
      // The server's own browser writes the recording on this machine, so its path is returned as is.
      preview_recording_stop: inRun((input) =>
        invokeTargeted<PreviewAutomationRecordingArtifact>(
          "recordingStop",
          input,
          PREVIEW_RECORDING_STOP_TIMEOUT_MS,
        ),
      ),
    };
  }),
);

export const layerSnapshot = McpToolAccess.toLayer(
  BrowserRunSnapshotToolkit,
  Effect.gen(function* () {
    const runs = yield* BrowserRuns.BrowserRuns;
    return {
      preview_snapshot: McpToolAccess.inBrowserRun(runs, (input) =>
        Effect.gen(function* () {
          const { includeImage, save, ...operationInput } = input ?? {};
          const snapshot = yield* invokeTargeted<PreviewAutomationSnapshot>("snapshot", {
            ...operationInput,
            ...(save === true ? { fullScreenshot: true } : {}),
          });
          // A saved screenshot goes to a file; one returned inline counts against the run's output.
          if (includeImage === true && snapshot.screenshot !== undefined) {
            const scope = yield* McpInvocationContext.McpInvocationContext;
            yield* runs.charge(scope.browserRunId ?? "", snapshot.screenshot.data.length);
          }
          return snapshot;
        }),
      ),
    };
  }),
);
