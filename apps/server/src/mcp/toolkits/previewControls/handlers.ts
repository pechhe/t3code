import * as Effect from "effect/Effect";
import { requireThreadMcpCapability } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { unavailable } from "../../threadAccess.ts";
import { PreviewControlsToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(PreviewControlsToolkit, {
  t3_preview_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireThreadMcpCapability("preview");
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      return yield* broker.list({ scope, ...input }).pipe(Effect.mapError(unavailable));
    }),
  ),
  t3_preview_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireThreadMcpCapability("preview");
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      // A browser backend's refusal says why; a preview manager failure does not.
      yield* broker.close({ scope, tabId: input.tabId }).pipe(
        Effect.catchTags({
          PreviewSessionLookupError: () => Effect.fail(unavailable()),
          PreviewInvalidUrlError: () => Effect.fail(unavailable()),
          PreviewControlRequiredError: () => Effect.fail(unavailable()),
        }),
      );
      return {};
    }),
  ),
});
