import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useEnvironments } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { isSidebarSubagentThread } from "~/components/Sidebar.logic";
import { readThreadShells } from "~/state/entities";
import { useUiStateStore } from "~/uiStateStore";
import { useNewThreadHandler } from "./useHandleNewThread";
import { resolveNewThreadEnvironmentId } from "./newThreadEnvironment.logic";

function reportScratchFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

export function useScratchProject() {
  const { environments } = useEnvironments();
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  const scratchWorkspaceRootFor = (environmentId: EnvironmentId | null): string | null => {
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    return availableScratchWorkspaceRoot(environment?.connection.phase, environment?.serverConfig);
  };

  const scratchEnvironmentId = (current: EnvironmentId | null): EnvironmentId | null => {
    if (current !== null) return scratchWorkspaceRootFor(current) !== null ? current : null;
    const offering = environments.filter(
      (entry) => scratchWorkspaceRootFor(entry.environmentId) !== null,
    );
    return offering.length === 1 ? (offering[0]?.environmentId ?? null) : null;
  };

  // Where the newest thread was started, not where the user last looked: a new thread
  // goes where the last one did, however many others were opened since. Read at call time
  // so users of this hook do not re-render on every thread update.
  const lastStartedEnvironmentId = (): EnvironmentId | null => {
    let latest: ReturnType<typeof readThreadShells>[number] | undefined;
    for (const thread of readThreadShells()) {
      if (isSidebarSubagentThread(thread)) continue;
      if (latest === undefined || thread.createdAt > latest.createdAt) latest = thread;
    }
    return latest?.environmentId ?? null;
  };

  // Where the composer's switch was last left, so a new thread opens on the machine the
  // user chose rather than wherever the newest thread happened to start.
  const newThreadEnvironmentId = (): EnvironmentId | null => {
    const remembered = useUiStateStore.getState().newThreadEnvironmentId;
    return resolveNewThreadEnvironmentId({
      remembered: remembered === null ? null : EnvironmentId.make(remembered),
      lastStarted: lastStartedEnvironmentId(),
      scratchEnvironmentIds: environments
        .filter((entry) => scratchWorkspaceRootFor(entry.environmentId) !== null)
        .map((entry) => entry.environmentId),
    });
  };

  const openScratchProject = async (
    environmentId: EnvironmentId,
    failureTitle = "Could not start without a project",
  ): Promise<EnvironmentProject | null> => {
    const result = await openScratch({ environmentId, input: {} });
    if (result._tag === "Success") return result.value;
    if (!isAtomCommandInterrupted(result)) {
      reportScratchFailure(failureTitle, squashAtomCommandFailure(result));
    }
    return null;
  };

  const startScratchThread = async (environmentId: EnvironmentId) => {
    const project = await openScratchProject(environmentId);
    if (project) {
      await handleNewThread(scopeProjectRef(project.environmentId, project.id)).catch(
        (error: unknown) => reportScratchFailure("Could not start without a project", error),
      );
    }
  };

  return {
    scratchWorkspaceRootFor,
    scratchEnvironmentId,
    newThreadEnvironmentId,
    openScratchProject,
    startScratchThread,
  };
}
