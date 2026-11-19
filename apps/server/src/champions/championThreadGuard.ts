import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

/**
 * A Champion owner thread with live children keeps its thread and workspace
 * (fork/differences.md `champions`): archiving, deleting or moving it is refused.
 */
export const refuseChampionWorkspaceLoss = Effect.fn("Champions.refuseWorkspaceLoss")(function* (
  orchestrator: Pick<Orchestrator.OrchestratorV2["Service"], "getThreadShell" | "getThreadRecords">,
  command: OrchestrationV2ServerCommand,
) {
  if (
    command.type !== "thread.archive" &&
    command.type !== "thread.delete" &&
    !(command.type === "thread.metadata.update" && command.worktreePath !== undefined)
  ) {
    return;
  }
  const shell = yield* orchestrator.getThreadShell(command.threadId);
  if (shell?.champion === undefined) return;
  const { subagents } = yield* orchestrator.getThreadRecords(command.threadId, ["subagents"]);
  if (
    subagents.some(
      (task) =>
        task.origin === "app_owned" &&
        task.childThreadId !== null &&
        !["completed", "failed", "cancelled", "interrupted"].includes(task.status),
    )
  )
    return yield* new Orchestrator.OrchestratorCommandRejectedError({
      commandId: command.commandId,
      commandType: command.type,
      cause: "A champion owner with live children must retain its thread and workspace.",
    });
});
