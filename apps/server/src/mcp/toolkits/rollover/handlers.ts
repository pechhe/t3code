import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NoteService from "../../../orchestration-v2/ContextRolloverNoteService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { RolloverToolkit } from "./tools.ts";

const handlers = {
  t3_write_rollover_note: McpToolAccess.readsAsCaller(({ note }) =>
    Effect.gen(function* () {
      const { thread: caller } = yield* McpInvocationContext.requireThreadScope(
        yield* McpInvocationContext.McpInvocationContext,
        "t3_write_rollover_note",
      );
      yield* (yield* NoteService.ContextRolloverNoteService).submit({
        threadId: caller.threadId,
        note,
      });
      return {
        message:
          "Saved. End your turn now with one short line at most; the thread continues on a fresh session seeded with this note.",
      };
    }).pipe(
      Effect.provide(NoteService.layer),
      Effect.mapError((error) =>
        error._tag === "RolloverNoteError"
          ? new OrchestratorMcpFailure({
              code: error.reason === "operation" ? "orchestration_error" : error.reason,
              message: error.message,
            })
          : error,
      ),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof RolloverToolkit.tools>;
export const layer = McpToolAccess.toLayer(RolloverToolkit, handlers);
