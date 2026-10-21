import type { OrchestrationV2WorkspaceAttachment } from "@t3tools/contracts";

interface HoldsAttachments {
  readonly workspaceAttachments?: ReadonlyArray<OrchestrationV2WorkspaceAttachment> | undefined;
}

/** The attachments a thread still holds: those SlipJay has not released. */
export const liveWorkspaceAttachments = (
  thread: HoldsAttachments,
): ReadonlyArray<OrchestrationV2WorkspaceAttachment> =>
  (thread.workspaceAttachments ?? []).filter((attachment) => attachment.releasedAt === null);
