import type { AgentRole, AgentToolProfile } from "./agentPolicy.ts";

/**
 * A set of T3 MCP tools one thread's harness may be shown. Listing is a
 * presentation decision: the capability checks on each call still decide what
 * the caller may do.
 */
export type ToolFamily =
  | "control"
  | "workspace"
  | "scheduling"
  | "preview"
  | "device"
  | "queue"
  | "worktree"
  | "project"
  | "experiments";

export interface SessionToolProfile {
  readonly toolProfile?: AgentToolProfile | undefined;
  readonly agentRole?: AgentRole | undefined;
}

const SCHEDULING_TOOLS = new Set([
  "schedule_task",
  "list_scheduled_tasks",
  "update_scheduled_task",
  "delete_scheduled_task",
  "run_scheduled_task_now",
]);

/**
 * Workspace moves and project discovery an ordinary thread is told to use: the
 * orchestration instructions name `t3_worktree_handoff` and `create_threads`,
 * and a No project chat is told to move itself with `t3_thread_move_to_project`
 * after reading `t3_project_list`. They stay reachable from every profile that
 * includes `control`.
 */
const CONTROL_EXTRA_TOOLS = new Set([
  "create_threads",
  "t3_project_list",
  "t3_thread_move_to_project",
  "t3_thread_suggest_project",
]);

/** Thread tools the orchestrator itself offers; the rest of the thread family is workspace administration. */
const CORE_THREAD_TOOLS = new Set([
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_update",
  "t3_thread_send",
  "t3_thread_wait",
  "t3_thread_interrupt",
  "t3_thread_launch",
  "watch",
  "unwatch",
]);

const PULL_REQUEST_TOOLS = new Set([
  "link_pull_request",
  "unlink_pull_request",
  "list_thread_pull_requests",
  "watch_pull_request",
  "unwatch_pull_request",
  "write_pull_request_guides",
  "read_pull_request_guide",
]);

/**
 * Which family a tool belongs to. Prefixes keep this one table without naming
 * every tool again when a family gains one.
 */
export const toolFamily = (name: string): ToolFamily => {
  if (SCHEDULING_TOOLS.has(name)) return "scheduling";
  if (name.startsWith("t3_experiments_") || name.startsWith("t3_work_")) return "experiments";
  if (name.startsWith("preview_") || name.startsWith("t3_preview_")) return "preview";
  if (name.startsWith("device_")) return "device";
  if (name.startsWith("t3_queue_")) return "queue";
  if (CONTROL_EXTRA_TOOLS.has(name)) return "control";
  if (name.startsWith("t3_worktree_")) return "worktree";
  if (name.startsWith("t3_project_") || name === "t3_hq_connection") return "project";
  if (PULL_REQUEST_TOOLS.has(name)) return "workspace";
  if (name.startsWith("html_")) return "control";
  if (name.startsWith("t3_attachment_") || name === "t3_thread_send_attachments")
    return "workspace";
  if (name === "t3_video_frames") return "workspace";
  if (name.startsWith("t3_environment_") || name === "t3_fleet_summary") return "workspace";
  if (name === "t3_terminal_read") return "workspace";
  if (name.startsWith("t3_thread_") && !CORE_THREAD_TOOLS.has(name)) return "workspace";
  if (name === "agent_task_outcome" || name === "agent_session_attach") return "workspace";
  return "control";
};

const CONTROL: ReadonlySet<ToolFamily> = new Set(["control", "scheduling", "worktree"]);
const WORKSPACE: ReadonlySet<ToolFamily> = new Set([
  "control",
  "workspace",
  "scheduling",
  "queue",
  "worktree",
  "project",
]);
const PREVIEW: ReadonlySet<ToolFamily> = new Set([
  "control",
  "workspace",
  "scheduling",
  "project",
  "preview",
]);
const PREVIEW_DEVICE: ReadonlySet<ToolFamily> = new Set([
  "control",
  "workspace",
  "scheduling",
  "project",
  "preview",
  "device",
]);
const IMPLEMENTATION_PHI: ReadonlySet<ToolFamily> = new Set([
  "control",
  "workspace",
  "scheduling",
  "worktree",
  "project",
  "preview",
]);
const RESEARCH: ReadonlySet<ToolFamily> = new Set([
  "control",
  "workspace",
  "scheduling",
  "queue",
  "worktree",
  "project",
  "experiments",
]);

export type SessionEndpointKey =
  | "control"
  | "workspace"
  | "research"
  | "preview"
  | "ui-verifier"
  | "implementation-phi";

/**
 * The one policy table: each endpoint's path and the families its `tools/list`
 * serves. A thread without a tool profile is an ordinary orchestrator thread.
 * Phi is what grants the preview family; the project setting that permits a
 * browser remains a call-time permission.
 */
export const SESSION_TOOL_ENDPOINTS: Readonly<
  Record<SessionEndpointKey, { readonly path: string; readonly families: ReadonlySet<ToolFamily> }>
> = {
  control: { path: "/mcp/control", families: CONTROL },
  workspace: { path: "/mcp/workspace", families: WORKSPACE },
  research: { path: "/mcp/research", families: RESEARCH },
  preview: { path: "/mcp/preview", families: PREVIEW },
  "ui-verifier": { path: "/mcp/ui-verifier", families: PREVIEW_DEVICE },
  "implementation-phi": {
    path: "/mcp/implementation-phi",
    families: IMPLEMENTATION_PHI,
  },
};

export const sessionEndpointKey = (session: SessionToolProfile | undefined): SessionEndpointKey => {
  if (session === undefined) return "control";
  if (session.agentRole === "ui-verifier") return "ui-verifier";
  switch (session.toolProfile) {
    case "phi":
      return "preview";
    case "implementation-phi":
      return "implementation-phi";
    case "implementation":
    case "source-reader":
      return "workspace";
    case "web-research":
      return "research";
    default:
      return "control";
  }
};

const toolFamiliesForSession = (session: SessionToolProfile | undefined): ReadonlySet<ToolFamily> =>
  SESSION_TOOL_ENDPOINTS[sessionEndpointKey(session)].families;

export const isToolListedForSession = (
  name: string,
  session: SessionToolProfile | undefined,
): boolean => toolFamiliesForSession(session).has(toolFamily(name));
