import type { OrchestrationV2WorkspaceAttachment } from "@t3tools/contracts";

/** The attachments a thread still holds: not released by SlipJay, not handed to a moved chat. */
export const liveWorkspaceAttachments = (thread: {
  readonly workspaceAttachments?: ReadonlyArray<OrchestrationV2WorkspaceAttachment> | undefined;
}): ReadonlyArray<OrchestrationV2WorkspaceAttachment> =>
  (thread.workspaceAttachments ?? []).filter(
    (attachment) => attachment.releasedAt === null && attachment.movedTo === undefined,
  );
