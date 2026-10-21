import * as Effect from "effect/Effect";
import type {
  PreviewAutomationResizeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
} from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { unavailable } from "../../threadAccess.ts";
import { invokeTargeted, normalizePreviewOpenInput } from "../preview/handlers.ts";
import { ManagedBrowserSnapshotToolkit, ManagedBrowserToolkit } from "./tools.ts";

const scope = McpInvocationContext.requireThreadMcpCapability("preview");

/** Phi's own tabs for this task's thread. The integrated browser is not part of this endpoint. */
export const layer = McpToolAccess.toLayer(ManagedBrowserToolkit, {
  preview_open: McpToolAccess.asManagedBrowser((input) =>
    invokeTargeted<PreviewAutomationStatus>("open", normalizePreviewOpenInput(input)),
  ),
  preview_status: McpToolAccess.asManagedBrowser((input) =>
    invokeTargeted<PreviewAutomationStatus>("status", input ?? {}),
  ),
  preview_navigate: McpToolAccess.asManagedBrowser((input) =>
    invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
  ),
  preview_click: McpToolAccess.asManagedBrowser((input) =>
    invokeTargeted<object>("click", input, input.timeoutMs),
  ),
  preview_hover: McpToolAccess.asManagedBrowser((input) =>
    invokeTargeted<object>("hover", input, input.timeoutMs),
  ),
  preview_type: McpToolAccess.asManagedBrowser((input) =>
    invokeTargeted<object>("type", input, input.timeoutMs),
  ),
  preview_press: McpToolAccess.asManagedBrowser((input) => invokeTargeted<object>("press", input)),
  preview_scroll: McpToolAccess.asManagedBrowser((input) =>
    invokeTargeted<object>("scroll", input),
  ),
  preview_wait_for: McpToolAccess.asManagedBrowser((input) =>
    invokeTargeted<object>("waitFor", input, input.timeoutMs),
  ),
  preview_resize: McpToolAccess.asManagedBrowser((input) =>
    invokeTargeted<PreviewAutomationResizeResult>("resize", input, input.timeoutMs),
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
      yield* broker.close({ scope: caller, tabId: input.tabId }).pipe(Effect.mapError(unavailable));
      return {};
    }),
  ),
});

export const layerSnapshot = McpToolAccess.toLayer(ManagedBrowserSnapshotToolkit, {
  preview_snapshot: McpToolAccess.asManagedBrowser((input) => {
    // Output selection and saving are MCP-only; the browser still produces a complete snapshot.
    const { includeImage: _includeImage, save: _save, ...operationInput } = input ?? {};
    return invokeTargeted<PreviewAutomationSnapshot>("snapshot", operationInput);
  }),
});
