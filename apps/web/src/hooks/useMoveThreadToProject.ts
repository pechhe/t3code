import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { ProjectId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { newThreadId } from "../lib/utils";
import { readThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import * as ThreadUndo from "./threadUndo";

/**
 * Moves a No project chat into a project and opens the moved chat. The move
 * forks the conversation into the project and archives the original, and the fork
 * takes over the original's attached workspaces. Undo restores the original with
 * them and deletes the fork while the fork has no turn of its own.
 */
export function useMoveThreadToProject() {
  const moveToProject = useOrchestrationCommand(threadEnvironment.moveToProject, {
    label: "move chat to project",
  });
  const undoMove = useOrchestrationCommand(threadEnvironment.undoMoveToProject, {
    label: "undo chat move",
  });
  const router = useRouter();

  return useCallback(
    async (source: EnvironmentThreadShell, projectId: ProjectId) => {
      const { environmentId } = source;
      const sourceRef = scopeThreadRef(environmentId, source.id);
      const movedRef = scopeThreadRef(environmentId, newThreadId());
      const claim = ThreadUndo.begin("move", scopedThreadKey(sourceRef));
      const result = await moveToProject({
        environmentId,
        input: {
          sourceThreadId: source.id,
          targetThreadId: movedRef.threadId,
          projectId,
          title: source.title,
        },
      });
      if (result._tag === "Failure") {
        claim.finish();
        return result;
      }
      refreshArchivedThreadsForEnvironment(environmentId);
      showThreadUndoNotice({
        action: "Moved",
        claim,
        failureTitle: "Failed to undo move",
        undo: async () => {
          if (readThreadShell(movedRef)?.latestRun != null) {
            throw new Error("The moved chat has a new turn, so it stays in the project.");
          }
          const undone = await undoMove({
            environmentId,
            input: { sourceThreadId: source.id, targetThreadId: movedRef.threadId },
          });
          refreshArchivedThreadsForEnvironment(environmentId);
          if (undone._tag === "Failure") return undone;
          return settlePromise(() =>
            router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(sourceRef),
            }),
          );
        },
      });
      return settlePromise(() =>
        router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(movedRef),
        }),
      );
    },
    [moveToProject, router, undoMove],
  );
}
