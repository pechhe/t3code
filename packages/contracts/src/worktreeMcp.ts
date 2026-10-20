import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationV2WorkspaceAttachment } from "./orchestrationV2.ts";

const AbsolutePath = TrimmedNonEmptyString.check(Schema.isPattern(/^(?:[A-Za-z]:[\\/]|[\\/])/));

/**
 * The server picks the location in its managed worktrees folder.
 * Changing the thread's workspace detaches the live provider session, so the
 * current turn ends shortly after the handoff is recorded; the conversation
 * continues inside the worktree on the thread's next run.
 */
export const WorktreeMcpHandoffInput = Schema.Struct({
  branch: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Branch name to create for a new worktree (e.g. 'feature/my-change'); in a SlipJay project, the new workspace's task name. Required unless worktreePath is given.",
    }),
  ),
  worktreePath: Schema.optional(
    AbsolutePath.annotate({
      description:
        "Absolute path of an existing checkout of the project's repository, such as a SlipJay workspace allocated with `slipjay start`, to attach instead of creating one. The other creation fields are ignored.",
    }),
  ),
  baseRef: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Branch or ref the worktree branch starts from. Defaults to the branch currently checked out in the project workspace.",
    }),
  ),
  startFromOrigin: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Fetch the remote baseRef belongs to and start the worktree branch from its remote-tracking commit instead of the local ref. Defaults to the server's 'new worktrees start from remote' setting.",
    }),
  ),
  runSetupScript: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Run the project's configured setup script in the worktree after handoff. Defaults to true for a new worktree and false for an existing one.",
    }),
  ),
  continuationPrompt: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
      description:
        "Message queued as the thread's next turn after the handoff. The handoff detaches the current provider session, so pass the remaining work here to automatically resume inside the worktree; omit it to stop after the handoff and wait for the next message.",
    }),
  ),
});
export type WorktreeMcpHandoffInput = typeof WorktreeMcpHandoffInput.Type;

export const WorktreeMcpSetupScriptStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("started"),
    scriptName: TrimmedNonEmptyString,
    terminalId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("no-script"),
  }),
  Schema.Struct({
    status: Schema.Literal("skipped"),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    detail: Schema.String,
  }),
]);
export type WorktreeMcpSetupScriptStatus = typeof WorktreeMcpSetupScriptStatus.Type;

export const WorktreeMcpContinuationStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("scheduled"),
    delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
  }),
  Schema.Struct({
    status: Schema.Literal("skipped"),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    detail: Schema.String,
  }),
]);
export type WorktreeMcpContinuationStatus = typeof WorktreeMcpContinuationStatus.Type;

export const WorktreeMcpHandoffResult = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString).annotate({
    description: "The worktree's branch; null for a SlipJay workspace, which has none.",
  }),
  baseRef: Schema.NullOr(TrimmedNonEmptyString).annotate({
    description:
      "The ref a new worktree started from; null for a SlipJay workspace or an existing worktree.",
  }),
  startedFromOrigin: Schema.Boolean,
  setupScript: WorktreeMcpSetupScriptStatus,
  continuation: WorktreeMcpContinuationStatus,
  note: Schema.String,
});
export type WorktreeMcpHandoffResult = typeof WorktreeMcpHandoffResult.Type;

/**
 * Attaches a workspace in another registered project beside the thread's primary workspace.
 * The provider session keeps running where it is; the thread's tools, helpers, strip and Land
 * can use the attached workspace.
 */
export const WorktreeMcpAttachInput = Schema.Struct({
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Registered project to attach a workspace in. Required unless worktreePath is given; pass it with worktreePath when several projects are registered in that repository.",
    }),
  ),
  worktreePath: Schema.optional(
    AbsolutePath.annotate({
      description:
        "Absolute path of an existing checkout of the project's repository to adopt, such as a SlipJay workspace or the project's own root. Detach leaves it in place.",
    }),
  ),
  root: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Adopt the project's main checkout, for an ordinary repository worked on in place. Detach leaves it in place.",
    }),
  ),
  branch: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Branch for a new worktree; in a SlipJay project, the new workspace's task name. Used when neither worktreePath nor root is given.",
    }),
  ),
  baseRef: WorktreeMcpHandoffInput.fields.baseRef,
  startFromOrigin: WorktreeMcpHandoffInput.fields.startFromOrigin,
  runSetupScript: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Run the project's configured setup script in the workspace. Defaults to true for a new workspace and false for an existing one.",
    }),
  ),
});
export type WorktreeMcpAttachInput = typeof WorktreeMcpAttachInput.Type;

export const WorktreeMcpAttachResult = Schema.Struct({
  attachment: OrchestrationV2WorkspaceAttachment,
  setupScript: WorktreeMcpSetupScriptStatus,
});
export type WorktreeMcpAttachResult = typeof WorktreeMcpAttachResult.Type;

export const WorktreeMcpDetachInput = Schema.Struct({
  workspacePath: AbsolutePath.annotate({
    description: "The attached workspace to detach, as t3_worktree_status lists it.",
  }),
});
export type WorktreeMcpDetachInput = typeof WorktreeMcpDetachInput.Type;

export const WorktreeMcpDetachResult = Schema.Struct({
  released: Schema.Boolean.annotate({
    description:
      "True when the workspace was one T3 allocated and was released; false when it was adopted and left in place, or already released.",
  }),
});
export type WorktreeMcpDetachResult = typeof WorktreeMcpDetachResult.Type;

export const WorktreeMcpStatusResult = Schema.Struct({
  attached: Schema.Boolean.annotate({
    description: "True when this thread is attached to a worktree or SlipJay workspace.",
  }),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  projectWorkspaceRoot: TrimmedNonEmptyString.annotate({
    description: "Root of the project's main workspace checkout.",
  }),
  defaultStartFromOrigin: Schema.Boolean.annotate({
    description: "Server default used by t3_worktree_handoff when startFromOrigin is omitted.",
  }),
  attachments: Schema.Array(OrchestrationV2WorkspaceAttachment).annotate({
    description:
      "Workspaces attached in other projects. One with releasedAt set was released by SlipJay, for example after landing, and its project can take a fresh attachment.",
  }),
});
export type WorktreeMcpStatusResult = typeof WorktreeMcpStatusResult.Type;

export class WorktreeMcpFailure extends Schema.TaggedError<WorktreeMcpFailure>()(
  "WorktreeMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "thread_not_found",
      "project_not_found",
      "handoff_in_progress",
      "invalid_request",
      "operation_failed",
      "thread_credential_required",
    ]),
    message: Schema.String,
  },
) {}
