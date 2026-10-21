import { useCallback } from "react";

import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useHandleNewThread } from "./useHandleNewThread";
import { useScratchProject } from "./useScratchProject";

/**
 * New thread, from the sidebar button or `chat.new`. It starts without a project, so it
 * never lands in the wrong one by default; the new-thread screen's project chips choose
 * one. A machine that offers no scratch folder starts in the current project instead.
 */
export function useStartNewThread() {
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const { scratchEnvironmentId, lastStartedEnvironmentId, startScratchThread } =
    useScratchProject();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  return useCallback(async () => {
    const environmentId = scratchEnvironmentId(lastStartedEnvironmentId() ?? primaryEnvironmentId);
    if (environmentId !== null) {
      await startScratchThread(environmentId);
      return;
    }
    await startNewThreadFromContext({
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef,
      handleNewThread,
    });
  }, [
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    handleNewThread,
    primaryEnvironmentId,
    scratchEnvironmentId,
    lastStartedEnvironmentId,
    startScratchThread,
  ]);
}
