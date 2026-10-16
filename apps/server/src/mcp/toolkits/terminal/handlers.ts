import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TerminalManager from "../../../terminal/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { TERMINAL_READ_DEFAULT_LINES, TerminalToolkit } from "./tools.ts";

const handlers = {
  // Scoped to the caller's own thread: terminal output can hold anything the user typed or printed.
  t3_terminal_read: McpToolAccess.readsAsCaller(({ terminalId, lines }) =>
    Effect.gen(function* () {
      const { thread: caller } = yield* McpInvocationContext.requireThreadScope(
        yield* McpInvocationContext.McpInvocationContext,
        "t3_terminal_read",
      );
      return yield* (yield* TerminalManager.TerminalManager).readThreadOutput({
        threadId: caller.threadId,
        terminalId,
        maxLines: lines ?? TERMINAL_READ_DEFAULT_LINES,
      });
    }).pipe(
      Effect.catchTags({
        TerminalSessionLookupError: (error) =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `This thread has no terminal ${error.terminalId}.`,
            }),
          ),
      }),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof TerminalToolkit.tools>;

export const layer = McpToolAccess.toLayer(TerminalToolkit, handlers);
