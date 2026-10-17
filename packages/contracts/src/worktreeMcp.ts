import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

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
    TrimmedNonEmptyString.check(Schema.isPattern(/^(?:[A-Za-z]:[\\/]|[\\/])/)).annotate({
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
        "Fetch origin and start the worktree branch from the remote-tracking commit of baseRef instead of the local ref. Defaults to the server's 'new worktrees start from origin' setting.",
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
