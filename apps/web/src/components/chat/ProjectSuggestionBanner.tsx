import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentThreadShell,
  threadRuntimeIsActive,
} from "@t3tools/client-runtime/state/models";
import { FolderInputIcon } from "lucide-react";
import { useState } from "react";

import { useMoveThreadToProject } from "../../hooks/useMoveThreadToProject";
import { useProject } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * The agent's suggestion to move this No project chat into a project, while
 * the user has neither moved the chat nor kept it where it is. The chat moves in
 * place, so the banner goes once it is no longer in No project.
 */
export function useProjectSuggestionBannerItem(
  thread: EnvironmentThreadShell | null,
  threadIsInNoProject: boolean,
): ComposerBannerStackItem | null {
  const suggestion =
    threadIsInNoProject && thread?.projectSuggestion?.dismissedAt === null
      ? thread.projectSuggestion
      : null;
  const projectRef =
    thread === null || suggestion === null
      ? null
      : scopeProjectRef(thread.environmentId, suggestion.projectId);
  const project = useProject(projectRef);
  const moveThreadToProject = useMoveThreadToProject();
  const dismissSuggestion = useOrchestrationCommand(threadEnvironment.dismissProjectSuggestion, {
    label: "keep chat in No project",
  });
  const [pending, setPending] = useState(false);

  if (thread === null || suggestion === null || project === null) return null;
  const running = threadRuntimeIsActive(thread.runtime);
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
    title: `Move to ${project.title}?`,
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
        <Button
          size="xs"
          variant="outline"
          disabled={pending || running}
          title={running ? "Move after the current turn finishes" : undefined}
          onClick={() => void run(() => moveThreadToProject(thread, suggestion.projectId))}
        >
          Move
        </Button>
      </>
    ),
  };
}
