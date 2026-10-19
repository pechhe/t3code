import type { OrchestrationV2WorkspaceAttachment, ProjectId } from "@t3tools/contracts";
import { listedWorkspaceAttachments } from "@t3tools/shared/workspaceAttachments";

export interface SelectedWorkspace {
  /** The project whose root, scripts and icon this workspace uses. */
  projectId: ProjectId;
  /** Null only for a primary workspace that is the project's root checkout. */
  worktreePath: string | null;
  branch: string | null;
  /** Null while the primary workspace is selected. */
  attachment: OrchestrationV2WorkspaceAttachment | null;
}

/**
 * The workspace the git panel, diff, terminal and Land act on: the selected attachment while
 * the thread still holds it live, otherwise the primary workspace.
 */
export function resolveSelectedWorkspace(input: {
  primary: { projectId: ProjectId; worktreePath: string | null; branch: string | null };
  attachments: ReadonlyArray<OrchestrationV2WorkspaceAttachment> | undefined;
  selectedWorkspacePath: string | null;
}): SelectedWorkspace {
  const attachment =
    input.selectedWorkspacePath === null
      ? undefined
      : listedWorkspaceAttachments({ workspaceAttachments: input.attachments }).find(
          (candidate) =>
            candidate.workspacePath === input.selectedWorkspacePath &&
            candidate.releasedAt === null,
        );
  if (attachment === undefined) return { ...input.primary, attachment: null };
  return {
    projectId: attachment.projectId,
    worktreePath: attachment.workspacePath,
    branch: attachment.branch,
    attachment,
  };
}

export interface WorkspaceChip {
  /** The attachment's workspace path; null for the primary workspace. */
  workspacePath: string | null;
  projectId: ProjectId;
  /** The checkout whose git status the chip reads; null for a released attachment. */
  statusCwd: string | null;
  branch: string | null;
  selected: boolean;
  released: boolean;
  /** Only an attachment can be detached. */
  detachable: boolean;
}

/**
 * The strip's chips: the primary workspace and one per listed attachment. A thread without
 * attachments needs no chips.
 */
export function deriveWorkspaceChips(input: {
  primary: { projectId: ProjectId; statusCwd: string; branch: string | null };
  attachments: ReadonlyArray<OrchestrationV2WorkspaceAttachment> | undefined;
  selected: SelectedWorkspace;
}): ReadonlyArray<WorkspaceChip> {
  const attachments = listedWorkspaceAttachments({ workspaceAttachments: input.attachments });
  if (attachments.length === 0) return [];
  const selectedPath = input.selected.attachment?.workspacePath ?? null;
  return [
    {
      workspacePath: null,
      projectId: input.primary.projectId,
      statusCwd: input.primary.statusCwd,
      branch: input.primary.branch,
      selected: selectedPath === null,
      released: false,
      detachable: false,
    },
    ...attachments.map((attachment) => {
      const released = attachment.releasedAt !== null;
      return {
        workspacePath: attachment.workspacePath,
        projectId: attachment.projectId,
        statusCwd: released ? null : attachment.workspacePath,
        branch: attachment.branch,
        selected: selectedPath === attachment.workspacePath,
        released,
        detachable: true,
      };
    }),
  ];
}

/**
 * The attachments whose workspaces the delete flow offers to remove: live ones T3 allocated.
 * Adopted checkouts were the owner's, and a released one is already gone.
 */
export function attachmentsToRemoveOnDelete(
  attachments: ReadonlyArray<OrchestrationV2WorkspaceAttachment> | undefined,
): ReadonlyArray<OrchestrationV2WorkspaceAttachment> {
  return listedWorkspaceAttachments({ workspaceAttachments: attachments }).filter(
    (attachment) => attachment.origin === "allocated" && attachment.releasedAt === null,
  );
}

/**
 * A chip's second line: the SlipJay base or the Git ref, and the count of uncommitted edits
 * the primary row shows. A released attachment has no checkout left to read.
 */
export function resolveWorkspaceChipDetail(input: {
  released: boolean;
  branch: string | null;
  status: {
    refName: string | null;
    hasWorkingTreeChanges: boolean;
    workingTree: { files: ReadonlyArray<unknown> };
    slipJay?: { integration: string | null } | undefined;
  } | null;
}): { label: string | null; editedFileCount: number } {
  if (input.released) return { label: "Released", editedFileCount: 0 };
  const { status } = input;
  const base =
    status?.slipJay?.integration != null
      ? `on ${status.slipJay.integration}`
      : (status?.refName ?? input.branch);
  return {
    label: base,
    editedFileCount: status?.hasWorkingTreeChanges ? status.workingTree.files.length : 0,
  };
}
