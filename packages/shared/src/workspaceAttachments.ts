import type { OrchestrationV2WorkspaceAttachment } from "@t3tools/contracts";

interface HoldsAttachments {
  readonly workspaceAttachments?: ReadonlyArray<OrchestrationV2WorkspaceAttachment> | undefined;
}

/** The attachments a thread lists: every one except those handed to a moved chat. */
export const listedWorkspaceAttachments = (
  thread: HoldsAttachments,
): ReadonlyArray<OrchestrationV2WorkspaceAttachment> =>
  (thread.workspaceAttachments ?? []).filter((attachment) => attachment.movedTo === undefined);

/** The attachments a thread still holds: listed and not released by SlipJay. */
export const liveWorkspaceAttachments = (
  thread: HoldsAttachments,
): ReadonlyArray<OrchestrationV2WorkspaceAttachment> =>
  listedWorkspaceAttachments(thread).filter((attachment) => attachment.releasedAt === null);
