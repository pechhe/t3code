import * as PhiBrowser from "../../../preview/PhiBrowser.ts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Preview from "../../../preview/Manager.ts";
import { requireThreadMcpCapability } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { PreviewControlsToolkit } from "./tools.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const access = Effect.gen(function* () {
  // The preview capability already reflects the calling project's access setting.
  const scope = yield* requireThreadMcpCapability("preview");
  return { scope, manager: yield* Preview.PreviewManager };
});
export const layer = McpToolAccess.toLayer(PreviewControlsToolkit, {
  t3_preview_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, manager } = yield* access;
      const result = yield* manager.list({ threadId: scope.thread.threadId });
      const phi = yield* Effect.serviceOption(PhiBrowser.PhiBrowser);
      const phiTabs = Option.isSome(phi) ? yield* phi.value.list(scope) : [];
      const sessions = [...result.sessions, ...phiTabs];
      const start = input.cursor ?? 0;
      const end = start + (input.limit ?? 20);
      return {
        ...result,
        sessions: sessions.slice(start, end),
        nextCursor: end < sessions.length ? end : null,
      };
    }),
  ),
  t3_preview_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, manager } = yield* access;
      const phi = yield* Effect.serviceOption(PhiBrowser.PhiBrowser);
      if (Option.isSome(phi) && (yield* phi.value.hasTab(input.tabId))) {
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        yield* broker
          .invoke({ scope, operation: "close", input: {}, tabId: input.tabId })
          .pipe(Effect.mapError(unavailable));
        return {};
      }
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      if (
        sessions.some((session) => session.tabId === input.tabId && session.runtime === "server")
      ) {
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        yield* broker
          .invoke({ scope, operation: "close", input: {}, tabId: input.tabId })
          .pipe(Effect.mapError(unavailable));
        return {};
      }
      yield* manager
        .close({ threadId: scope.thread.threadId, tabId: input.tabId })
        .pipe(Effect.mapError(unavailable));
      return {};
    }),
  ),
});
