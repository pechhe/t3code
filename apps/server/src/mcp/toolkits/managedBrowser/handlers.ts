import * as Effect from "effect/Effect";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import type {
  PreviewAutomationResizeResult,
  PreviewAutomationRecordingStatus,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationSelectResult,
} from "@t3tools/contracts";

import * as BrowserTaskService from "../../../browserTasks/BrowserTaskService.ts";
import * as BrowserLogins from "../../../secrets/BrowserLogins.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { assertManagedBrowserCaller } from "../../ManagedBrowserAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { assertLiveCaller, unavailable } from "../../threadAccess.ts";
import { assertDecisionCaller } from "../decisions/handlers.ts";
import {
  claimPreviewRecording,
  invoke,
  invokeTargeted,
  normalizePreviewOpenInput,
} from "../preview/handlers.ts";
import {
  ManagedBrowserSnapshotToolkit,
  ManagedBrowserTaskToolkit,
  ManagedBrowserToolkit,
} from "./tools.ts";

const scope = McpInvocationContext.requireThreadMcpCapability("preview");

/** Only the task's selected backend and owned tabs are reachable from this endpoint. */
export const layer = McpToolAccess.toLayer(
  ManagedBrowserToolkit,
  Effect.gen(function* () {
    const logins = yield* BrowserLogins.BrowserLogins;
    return {
      preview_open: McpToolAccess.asManagedBrowser((input) =>
        invokeTargeted<PreviewAutomationStatus>("open", normalizePreviewOpenInput(input)).pipe(
          Effect.flatMap(BrowserLogins.withLoginKeys(logins)),
        ),
      ),
      preview_status: McpToolAccess.asManagedBrowser((input) =>
        invokeTargeted<PreviewAutomationStatus>("status", input ?? {}).pipe(
          Effect.flatMap(BrowserLogins.withLoginKeys(logins)),
        ),
      ),
      preview_navigate: McpToolAccess.asManagedBrowser((input) =>
        invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
      ),
      preview_interact: McpToolAccess.asManagedBrowser(({ action, ...input }) => {
        switch (action) {
          case "click":
            return invokeTargeted<object>("click", input, input.timeoutMs);
          case "type":
            return invokeTargeted<object>("type", input, input.timeoutMs);
          case "hover":
            return invokeTargeted<object>("hover", input, input.timeoutMs);
          case "select":
            return invokeTargeted<PreviewAutomationSelectResult>("select", input, input.timeoutMs);
          case "drag":
            return invokeTargeted<object>("drag", input, input.timeoutMs);
          case "press":
            return invokeTargeted<object>("press", input, input.timeoutMs);
          case "scroll":
            return invokeTargeted<object>("scroll", input, input.timeoutMs);
        }
      }),
      preview_wait_for: McpToolAccess.asManagedBrowser((input) =>
        invokeTargeted<object>("waitFor", input, input.timeoutMs),
      ),
      preview_resize: McpToolAccess.asManagedBrowser((input) =>
        invokeTargeted<PreviewAutomationResizeResult>("resize", input, input.timeoutMs),
      ),
      preview_set_appearance: McpToolAccess.asManagedBrowser((input) =>
        invokeTargeted<PreviewAutomationSetColorSchemeResult>("setColorScheme", input),
      ),
      preview_recording_start: McpToolAccess.asManagedBrowser((input) =>
        invokeTargeted<PreviewAutomationRecordingStatus>("recordingStart", input),
      ),
      preview_recording_stop: McpToolAccess.asManagedBrowser((input) =>
        Effect.gen(function* () {
          const caller = yield* scope;
          const response = yield* invoke<unknown>(
            "recordingStop",
            { transferToEnvironment: true },
            120_000,
            input.tabId,
          );
          return yield* claimPreviewRecording(caller.thread.threadId, response.result);
        }),
      ),
      preview_handoff: McpToolAccess.asManagedBrowser((input) =>
        invokeTargeted<object>("handoff", input),
      ),
      preview_resume: McpToolAccess.asManagedBrowser((input) =>
        invokeTargeted<object>("resume", input),
      ),
      t3_preview_list: McpToolAccess.asManagedBrowser((input) =>
        Effect.gen(function* () {
          const caller = yield* scope;
          const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
          return yield* broker.list({ scope: caller, ...input }).pipe(Effect.mapError(unavailable));
        }),
      ),
      t3_preview_close: McpToolAccess.cleansUpAsManagedBrowser((input) =>
        Effect.gen(function* () {
          const caller = yield* scope;
          const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
          yield* broker
            .close({ scope: caller, tabId: input.tabId })
            .pipe(Effect.mapError(unavailable));
          return {};
        }),
      ),
    };
  }),
);

export const layerSnapshot = McpToolAccess.toLayer(ManagedBrowserSnapshotToolkit, {
  preview_snapshot: McpToolAccess.asManagedBrowser((input) => {
    // Output selection and saving are MCP-only; the browser still produces a complete snapshot.
    const { includeImage: _includeImage, save: _save, ...operationInput } = input ?? {};
    return invokeTargeted<PreviewAutomationSnapshot>("snapshot", operationInput);
  }),
});

const taskCaller = Effect.gen(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (invocation.thread === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "A bounded browser task needs a managed browser thread.",
    });
  return { ...invocation, thread: invocation.thread };
});

export const layerTask = McpToolAccess.toLayer(ManagedBrowserTaskToolkit, {
  preview_task: McpToolAccess.asManagedBrowser((request) =>
    Effect.gen(function* () {
      const caller = yield* taskCaller;
      const tasks = yield* BrowserTaskService.BrowserTaskService;
      const services = yield* Effect.context<
        McpInvocationContext.McpInvocationContext | ThreadManagementService.ThreadManagementService
      >();
      // Rechecked before each provider call and dispatch, so a long run cannot outlive its authority.
      const authorize = assertManagedBrowserCaller({ checkSettings: true }).pipe(
        Effect.flatMap((live) => assertLiveCaller(live)),
        Effect.andThen(assertDecisionCaller),
        Effect.asVoid,
        Effect.provide(services),
      );
      return yield* tasks.run({ scope: caller, request, authorize });
    }),
  ),
  // Stopping stays possible after browser access is revoked, like closing a tab.
  preview_task_cancel: McpToolAccess.cleansUpAsManagedBrowser(({ requestId }) =>
    Effect.gen(function* () {
      const caller = yield* taskCaller;
      const tasks = yield* BrowserTaskService.BrowserTaskService;
      return yield* tasks.cancel({ scope: caller, requestId });
    }),
  ),
});
