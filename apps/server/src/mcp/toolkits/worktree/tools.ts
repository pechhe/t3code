import {
  WorktreeMcpFailure,
  OrchestratorMcpFailure,
  VcsListRefsInput,
  VcsListRefsResult,
  WorktreeMcpAttachInput,
  WorktreeMcpAttachResult,
  WorktreeMcpDetachInput,
  WorktreeMcpDetachResult,
  WorktreeMcpHandoffInput,
  WorktreeMcpHandoffResult,
  WorktreeMcpStatusResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  WorktreeMcpService.WorktreeMcpService,
];

const WorktreeToolFailure = Schema.Union([WorktreeMcpFailure, OrchestratorMcpFailure]);

const WorktreeHandoffTool = Tool.make("t3_worktree_handoff", {
  description:
    "Needs an agent running inside a T3 thread. Move this agent thread into another workspace: a new one, or with worktreePath an existing checkout of the project's repository (such as a SlipJay workspace allocated with `slipjay start`). Works whether or not the thread is already attached to one; the previous workspace is left as it is. To launch a separate agent bound to a workspace, use t3_thread_launch with workspaceStrategy instead. A new worktree gets the branch (optionally from origin); in a repository with slipjay.json it is instead a SlipJay workspace from the integration branch, named after branch (baseRef, startFromOrigin and path are ignored). Re-points the thread at the checkout, and runs the project's setup script in a new one by default. Changing the workspace detaches the live provider session, so the current turn ends shortly after the handoff is recorded; call this as the last action of the turn. To keep working after the handoff, pass continuationPrompt with a one-sentence next step: it is queued as the thread's next message and starts a new turn inside the workspace with the conversation preserved, so it never needs to restate the work so far. Without it the thread stays idle until the next message. A new worktree is not removed automatically when the thread is deleted.",
  parameters: WorktreeMcpHandoffInput,
  success: WorktreeMcpHandoffResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Hand off thread to another workspace")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const WorktreeStatusTool = Tool.make("t3_worktree_status", {
  description:
    "Needs an agent running inside a T3 thread. Report this agent thread's workspaces: whether its primary workspace is a worktree or SlipJay workspace, its path and branch, the project's main workspace root, the server default for startFromOrigin, and the workspaces attached in other projects. Call this before t3_worktree_handoff or t3_worktree_attach to see where the thread works now.",
  // No `parameters`: Tool.make defaults to Tool.EmptyParams, which serializes
  // to a top-level `type: "object"` JSON Schema. An explicit empty
  // Schema.Struct({}) serializes to `anyOf: [object, array]`, which is not a
  // valid MCP tool input schema and makes clients reject the whole server.
  success: WorktreeMcpStatusResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get thread worktree status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WorktreeAttachTool = Tool.make("t3_worktree_attach", {
  description:
    'Needs an agent running inside a T3 thread. Attach a workspace in another registered project to this thread, beside its primary workspace, when authorised work needs that project: work there by path, share it with helpers (workspaceAssignment "lead"), and land from it. A new one is a SlipJay workspace in a repository with slipjay.json, otherwise a git worktree on branch; worktreePath or root adopts an existing checkout instead. The provider session keeps running where it is. A project holds one live attachment per thread; once SlipJay releases it (for example after it lands) the project can take a fresh one. Detach with t3_worktree_detach.',
  parameters: WorktreeMcpAttachInput,
  success: WorktreeMcpAttachResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Attach a workspace in another project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const WorktreeDetachTool = Tool.make("t3_worktree_detach", {
  description:
    "Needs an agent running inside a T3 thread. Detach a workspace attached with t3_worktree_attach. One T3 allocated is released through SlipJay or git; detaching fails, and it stays attached, while it holds uncommitted edits or unlanded work, or while a Land or helper writer runs there. An adopted checkout is left in place.",
  parameters: WorktreeMcpDetachInput,
  success: WorktreeMcpDetachResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Detach an attached workspace")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const WorktreeListTool = Tool.make("t3_worktree_list", {
  description:
    "List branch refs and their associated checkout paths for a thread's workspace (omit threadId for this thread) using the app's ref inventory. Detached worktrees without a branch are not included. Use t3_worktree_status for the thread binding and t3_worktree_handoff to create a new worktree.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    query: VcsListRefsInput.fields.query,
    cursor: VcsListRefsInput.fields.cursor,
    limit: VcsListRefsInput.fields.limit,
    refKind: VcsListRefsInput.fields.refKind,
    includeMatchingRemoteRefs: VcsListRefsInput.fields.includeMatchingRemoteRefs,
  }),
  success: VcsListRefsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    GitWorkflowService.GitWorkflowService,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const WorktreeToolkit = Toolkit.make(
  WorktreeHandoffTool,
  WorktreeStatusTool,
  WorktreeAttachTool,
  WorktreeDetachTool,
  WorktreeListTool,
);
