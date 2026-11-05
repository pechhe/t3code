import { RegistryContext } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { useContext } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { isSidebarSubagentThread } from "~/components/Sidebar.logic";
import { readThreadShells } from "~/state/entities";
import { useUiStateStore } from "~/uiStateStore";
import { type NewThreadHandler, useNewThreadHandler } from "./useHandleNewThread";
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

type ScratchEnvironment = Pick<EnvironmentPresentation, "connection" | "serverConfig"> & {
  readonly environmentId: EnvironmentId;
};

export function createScratchProjectActions(input: {
  readonly environments: () => Iterable<ScratchEnvironment>;
  readonly primaryEnvironmentId: () => EnvironmentId | null;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly handleNewThread: NewThreadHandler;
}) {
  const scratchWorkspaceRootFor = (environmentId: EnvironmentId | null): string | null => {
    let environment: ScratchEnvironment | undefined;
    for (const entry of input.environments()) {
      if (entry.environmentId === environmentId) environment = entry;
    }
    return availableScratchWorkspaceRoot(environment?.connection.phase, environment?.serverConfig);
  };

  // The primary (local) environment wins; `fallback` only applies when it offers no scratch root.
  const scratchEnvironmentId = (fallback: EnvironmentId | null): EnvironmentId | null => {
    const primary = input.primaryEnvironmentId();
    if (primary !== null && scratchWorkspaceRootFor(primary) !== null) return primary;
    if (fallback !== null && scratchWorkspaceRootFor(fallback) !== null) return fallback;
    const offering = [...input.environments()].filter(
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
      scratchEnvironmentIds: Array.from(input.environments())
        .filter((entry) => scratchWorkspaceRootFor(entry.environmentId) !== null)
        .map((entry) => entry.environmentId),
    });
  };

  const openScratchProject = async (
    environmentId: EnvironmentId,
    failureTitle = "Could not start without a project",
  ): Promise<EnvironmentProject | null> => {
    const command = projectEnvironment.openScratch;
    const result = await runAtomCommand(
      input.registry,
      command,
      { environmentId, input: {} },
      { label: command.label, reportFailure: false, reportDefect: true },
    );
    if (result._tag === "Success") return result.value;
    if (!isAtomCommandInterrupted(result)) {
      reportScratchFailure(failureTitle, squashAtomCommandFailure(result));
    }
    return null;
  };

  const startScratchThread = async (environmentId: EnvironmentId) => {
    const project = await openScratchProject(environmentId);
    if (project) {
      await input
        .handleNewThread(scopeProjectRef(project.environmentId, project.id))
        .catch((error: unknown) =>
          reportScratchFailure("Could not start without a project", error),
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

export function useScratchProject() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const registry = useContext(RegistryContext);
  const handleNewThread = useNewThreadHandler();
  return createScratchProjectActions({
    environments: () => environments,
    primaryEnvironmentId: () => primaryEnvironmentId,
    registry,
    handleNewThread,
  });
}
