import { CommandId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { CommandReceiptV2 } from "./CommandReceiptStore.ts";

export class OrchestratorCommandReplayExpiredError extends Schema.TaggedError<OrchestratorCommandReplayExpiredError>()(
  "OrchestratorCommandReplayExpiredError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    threadId: ThreadId,
    expiredAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return `Command ${this.commandId} already ran, but its original response was removed when thread ${this.threadId}'s detail expired on ${DateTime.formatIso(this.expiredAt)}.`;
  }
}

/**
 * A replayed command whose receipt lost its response to thread-detail expiry
 * (fork/differences.md `thread-detail-expiry`) is refused rather than answered from what is left:
 * expiry keeps some of a thread's events, so a partial response is still a lost one.
 */
export const refuseExpiredReplay = (
  command: { readonly commandId: CommandId; readonly type: string },
  receipt: CommandReceiptV2,
): Effect.Effect<void, OrchestratorCommandReplayExpiredError> =>
  receipt.replayExpiredAt === undefined
    ? Effect.void
    : Effect.fail(
        new OrchestratorCommandReplayExpiredError({
          commandId: command.commandId,
          commandType: command.type,
          threadId: receipt.threadId,
          expiredAt: receipt.replayExpiredAt,
        }),
      );
