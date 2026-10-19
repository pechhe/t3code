import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { useSelectedWorkspaceStore } from "../selectedWorkspaceStore";
import { useQuietThreadShell } from "../state/entities";
import {
  resolveSelectedWorkspace,
  type SelectedWorkspace,
} from "@t3tools/client-runtime/thread-workspaces";

/**
 * The workspace the thread's git panel, diff, terminal and Land act on. A draft has no
 * attachments, so it resolves to its own project and worktree.
 */
export function useSelectedWorkspace(threadRef: ScopedThreadRef | null): SelectedWorkspace | null {
  const serverThread = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const selectedWorkspacePath = useSelectedWorkspaceStore((store) =>
    threadRef ? (store.byThreadKey[scopedThreadKey(threadRef)] ?? null) : null,
  );
  const primary = serverThread ?? draftThread;
  if (!primary) return null;
  return resolveSelectedWorkspace({
    primary: {
      projectId: primary.projectId,
      worktreePath: primary.worktreePath ?? null,
      branch: primary.branch ?? null,
    },
    attachments: serverThread?.workspaceAttachments,
    selectedWorkspacePath,
  });
}
