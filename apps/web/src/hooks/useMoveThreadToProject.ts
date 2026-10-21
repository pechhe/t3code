import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ProjectId } from "@t3tools/contracts";

import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import * as ThreadUndo from "./threadUndo";

/**
 * Moves a No project chat into a project in place: the chat keeps its id and history and
 * continues in the project's workspace. Undo puts it back while it has not run there; the
 * server refuses it after that.
 */
export function useMoveThreadToProject() {
  const moveToProject = useOrchestrationCommand(threadEnvironment.moveToProject, {
    label: "move chat to project",
  });
  const undoMove = useOrchestrationCommand(threadEnvironment.undoMoveToProject, {
    label: "undo chat move",
  });

  return async (source: EnvironmentThreadShell, projectId: ProjectId) => {
    const { environmentId } = source;
    const claim = ThreadUndo.begin(
      "move",
      scopedThreadKey(scopeThreadRef(environmentId, source.id)),
    );
    const result = await moveToProject({
      environmentId,
      input: { threadId: source.id, projectId },
    });
    if (result._tag === "Failure") {
      claim.finish();
      return result;
    }
    showThreadUndoNotice({
      action: "Moved",
      claim,
      failureTitle: "Failed to undo move",
      undo: () => undoMove({ environmentId, input: { threadId: source.id } }),
    });
    return result;
  };
}
