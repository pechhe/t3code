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
    "Needs an agent running inside a T3 thread. Move this thread into a new workspace, or with worktreePath into an existing checkout (such as a SlipJay workspace from `slipjay start`); the previous one is left as it is. A new worktree gets the branch, or in a repository with slipjay.json is a SlipJay workspace from the integration branch named after branch (baseRef, startFromOrigin and path are ignored), with the project's setup script by default. Changing workspace detaches the live provider session, so the turn ends after the handoff is recorded: call this last. continuationPrompt, one sentence, is queued as the thread's next message, starting a new turn there with the conversation preserved; without it the thread stays idle. A new worktree is not removed when the thread is deleted.",
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
    "Needs an agent running inside a T3 thread. Report this thread's workspaces: whether its primary one is a worktree or SlipJay workspace, its path and branch, the project's main workspace root, the startFromOrigin default, and workspaces attached in other projects. Call it before t3_worktree_handoff or t3_worktree_attach.",
  // Empty Struct emits object|array, making MCP clients reject the server; use EmptyParams for an object schema.
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
    'Needs an agent running inside a T3 thread. Attach a workspace in another registered project to this thread, beside its primary workspace, when authorised work needs that project: work there by path, share it with helpers (workspaceAssignment "lead") and land from it. A new one is a SlipJay workspace in a repository with slipjay.json, otherwise a git worktree; worktreePath or root adopts an existing checkout. One live attachment per project; the provider session keeps running where it is.',
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
    "Needs an agent running inside a T3 thread. Detach a workspace attached with t3_worktree_attach. One T3 allocated is released through SlipJay or git, and detaching fails while it holds uncommitted edits or unlanded work. An adopted checkout is left in place.",
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
    "List branch refs and their checkout paths for a thread's workspace (omit threadId for this thread) from the app's ref inventory; detached worktrees without a branch are left out. Use t3_worktree_status for the thread binding.",
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
