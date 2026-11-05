import type { PreviewAutomationSnapshot, PreviewAutomationStatus } from "@t3tools/contracts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BrowserTaskService from "../../../browserTasks/BrowserTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { assertBoundedBrowserCaller } from "../../ManagedBrowserAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { unavailable } from "../../threadAccess.ts";
import { invokeTargeted } from "../preview/handlers.ts";
import { BoundedBrowserSnapshotToolkit, BoundedBrowserToolkit } from "./tools.ts";

const scope = McpInvocationContext.requireThreadMcpCapability("preview");

const taskCaller = Effect.gen(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (invocation.thread === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "A bounded browser task needs a T3 thread.",
    });
  return { ...invocation, thread: invocation.thread };
});

export const layer = McpToolAccess.toLayer(BoundedBrowserToolkit, {
  t3_browser_open: McpToolAccess.asBoundedBrowser(({ url }) =>
    invokeTargeted<PreviewAutomationStatus>("open", {
      ...(url === undefined ? {} : { url }),
      open: false,
      show: false,
      reuseExistingTab: false,
    }),
  ),
  t3_browser_status: McpToolAccess.asBoundedBrowser(({ tabId }) =>
    invokeTargeted<PreviewAutomationStatus>("status", { tabId }),
  ),
  t3_browser_task: McpToolAccess.asBoundedBrowser((request) =>
    Effect.gen(function* () {
      const caller = yield* taskCaller;
      const tasks = yield* BrowserTaskService.BrowserTaskService;
      const services = yield* Effect.context<
        McpInvocationContext.McpInvocationContext | ThreadManagementService.ThreadManagementService
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
  t3_browser_task_cancel: McpToolAccess.cleansUpAsBoundedBrowser(({ requestId }) =>
    Effect.gen(function* () {
      const caller = yield* taskCaller;
      const tasks = yield* BrowserTaskService.BrowserTaskService;
      return yield* tasks.cancel({ scope: caller, requestId });
    }),
  ),
  t3_browser_close: McpToolAccess.cleansUpAsBoundedBrowser(({ tabId }) =>
    Effect.gen(function* () {
      const caller = yield* scope;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      yield* broker.close({ scope: caller, tabId }).pipe(Effect.mapError(unavailable));
      return {};
    }),
  ),
});

export const layerSnapshot = McpToolAccess.toLayer(BoundedBrowserSnapshotToolkit, {
  t3_browser_snapshot: McpToolAccess.asBoundedBrowser(
    ({ includeImage: _includeImage, save: _save, ...input }) =>
      invokeTargeted<PreviewAutomationSnapshot>("snapshot", input),
  ),
});
