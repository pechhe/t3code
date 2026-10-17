import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentThreadShell,
  threadRuntimeIsActive,
} from "@t3tools/client-runtime/state/models";
import { FolderInputIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { useMoveThreadToProject } from "../../hooks/useMoveThreadToProject";
import { useProject } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * The agent's suggestion to move this No project chat into a project, while
 * the user has neither moved the chat nor kept it where it is. A move the agent
 * made itself shows until it lands, then takes a viewer of this chat to the
 * moved one.
 */
export function useProjectSuggestionBannerItem(
  thread: EnvironmentThreadShell | null,
  threadIsInNoProject: boolean,
): ComposerBannerStackItem | null {
  const suggestion =
    threadIsInNoProject && thread?.projectSuggestion?.dismissedAt === null
      ? thread.projectSuggestion
      : null;
  const projectRef = useMemo(
    () =>
      thread === null || suggestion === null
        ? null
        : scopeProjectRef(thread.environmentId, suggestion.projectId),
    [thread, suggestion],
  );
  const project = useProject(projectRef);
  const moveThreadToProject = useMoveThreadToProject();
  const dismissSuggestion = useOrchestrationCommand(threadEnvironment.dismissProjectSuggestion, {
    label: "keep chat in No project",
  });
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const movedRef = useMemo(
    () =>
      thread !== null && thread.archivedAt !== null && suggestion?.move != null
        ? scopeThreadRef(thread.environmentId, suggestion.move.targetThreadId)
        : null,
    [thread, suggestion],
  );
  // Follow the move only when it lands while this chat is open, not when an
  // already moved chat is reopened from the archive.
  const lastSeen = useRef<{ threadId: string; moved: boolean } | null>(null);
  const threadId = thread?.id ?? null;
  useEffect(() => {
    const previous = lastSeen.current;
    lastSeen.current = threadId === null ? null : { threadId, moved: movedRef !== null };
    if (movedRef !== null && previous?.threadId === threadId && !previous.moved) {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(movedRef),
      });
    }
  }, [threadId, movedRef, router]);

  if (thread === null || suggestion === null || project === null) return null;
  if (movedRef !== null) {
    return {
      id: `project-suggestion:${thread.id}`,
      variant: "info",
      priority: "notice",
      icon: <FolderInputIcon />,
      title: `Moved to ${project.title}`,
      actions: (
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(movedRef),
            })
          }
        >
          Open
        </Button>
      ),
    };
  }
  const running = threadRuntimeIsActive(thread.runtime);
  const movesAfterTurn = suggestion.move !== null && running;
  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    try {
      await action();
    } finally {
      setPending(false);
    }
  };
  return {
    id: `project-suggestion:${thread.id}`,
    variant: "info",
    priority: "notice",
    icon: <FolderInputIcon />,
    title: movesAfterTurn
      ? `Moving to ${project.title} when this turn ends`
      : `Move to ${project.title}?`,
    description: suggestion.reason,
    actions: (
      <>
        <Button
          size="xs"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            void run(() =>
              dismissSuggestion({
                environmentId: thread.environmentId,
                input: { threadId: thread.id },
              }),
            )
          }
        >
          Keep
        </Button>
        {movesAfterTurn ? null : (
          <Button
            size="xs"
            variant="outline"
            disabled={pending || running}
            title={running ? "Move after the current turn finishes" : undefined}
            onClick={() => void run(() => moveThreadToProject(thread, suggestion.projectId))}
          >
            Move
          </Button>
        )}
      </>
    ),
  };
}
