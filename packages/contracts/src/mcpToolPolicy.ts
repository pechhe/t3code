import { WEAVE_NAMES } from "./weaveNames.ts";
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
  | "experiments"
  | "work"
  | "inspection"
  | "leaf"
  | "report";

export interface SessionToolProfile {
  readonly toolProfile?: AgentToolProfile | undefined;
  readonly agentRole?: AgentRole | undefined;
  /**
   * A thread with an `agentTask` is a delegated child: it lists only its own work
   * family and the leaf tools, never the orchestration control plane.
   */
  readonly delegated?: boolean | undefined;
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

/**
 * What a delegated child needs whatever its role: poll or cancel its own task,
 * watch something it started, report its outcome, and show the user a page. Its
 * own role's work family is the other half of every child listing.
 */
const LEAF_TOOLS = new Set([
  "task_status",
  "task_cancel",
  "watch",
  "unwatch",
  "html_preview",
  "html_render",
]);

/**
 * The tool a managed agent reports its outcome with. It is separate from the leaf
 * set because an ordinary thread never reports to a parent and never lists it.
 */
const REPORT_TOOLS = new Set(["agent_task_outcome"]);

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
  if (REPORT_TOOLS.has(name)) return "report";
  if (LEAF_TOOLS.has(name)) return "leaf";
  if (SCHEDULING_TOOLS.has(name)) return "scheduling";
  if (name.startsWith("t3_experiments_")) return "experiments";
  // Work-unit allocation and evidence are an implementer's tools, not a researcher's.
  if (name.startsWith("t3_work_")) return "work";
  // Source inspection is for external OAuth clients; no session endpoint lists it.
  if (name.startsWith("workspace_")) return "inspection";
  if (name.startsWith("preview_") || name.startsWith("t3_preview_")) return "preview";
  if (name.startsWith("device_")) return "device";
  if (name.startsWith("t3_queue_")) return "queue";
  if (CONTROL_EXTRA_TOOLS.has(name)) return "control";
  if (name.startsWith("t3_worktree_")) return "worktree";
  if (name.startsWith("t3_project_") || WEAVE_NAMES.connectionTools.some((tool) => tool === name))
    return "project";
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

const CONTROL: ReadonlySet<ToolFamily> = new Set(["control", "scheduling", "worktree", "leaf"]);
const WORKSPACE: ReadonlySet<ToolFamily> = new Set([
  "control",
  "workspace",
  "scheduling",
  "queue",
  "worktree",
  "project",
  "leaf",
  "report",
]);
/**
 * A browser session drives `preview_*`, and needs `leaf` for its own task status, cancel,
 * watch and the html tools that show the user a page, plus `report` for its outcome. It
 * orchestrates nothing, so it lists no control, workspace, scheduling, worktree or project
 * tool; that listing is the child-preview one.
 */
const PREVIEW: ReadonlySet<ToolFamily> = new Set(["preview", "leaf", "report"]);
const PREVIEW_DEVICE: ReadonlySet<ToolFamily> = new Set([
  "control",
  "workspace",
  "scheduling",
  "worktree",
  "project",
  "preview",
  "device",
  "leaf",
  "report",
]);
const IMPLEMENTATION_PHI: ReadonlySet<ToolFamily> = new Set([
  "control",
  "workspace",
  "scheduling",
  "worktree",
  "project",
  "preview",
  "leaf",
  "report",
]);
const RESEARCH: ReadonlySet<ToolFamily> = new Set([
  "control",
  "workspace",
  "scheduling",
  "queue",
  "worktree",
  "project",
  "experiments",
  "work",
  "leaf",
  "report",
]);

/**
 * A delegated child's listing: the leaf tools plus what its own role does, and
 * nothing that belongs to the thread that delegated it.
 */
const CHILD_READER: ReadonlySet<ToolFamily> = new Set(["leaf", "report"]);
const CHILD_RESEARCH: ReadonlySet<ToolFamily> = new Set(["leaf", "report", "experiments"]);
const CHILD_PREVIEW: ReadonlySet<ToolFamily> = new Set(["leaf", "report", "preview"]);
const CHILD_PREVIEW_DEVICE: ReadonlySet<ToolFamily> = new Set([
  "leaf",
  "report",
  "preview",
  "device",
]);
const CHILD_IMPLEMENTATION: ReadonlySet<ToolFamily> = new Set([
  "leaf",
  "report",
  "worktree",
  "project",
]);

export type SessionEndpointKey =
  | "control"
  | "workspace"
  | "research"
  | "preview"
  | "ui-verifier"
  | "implementation-phi"
  | "child-reader"
  | "child-research"
  | "child-preview"
  | "child-ui-verifier"
  | "child-implementation";

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
  "child-reader": { path: "/mcp/child-reader", families: CHILD_READER },
  "child-research": { path: "/mcp/child-research", families: CHILD_RESEARCH },
  "child-preview": { path: "/mcp/child-preview", families: CHILD_PREVIEW },
  "child-ui-verifier": { path: "/mcp/child-ui-verifier", families: CHILD_PREVIEW_DEVICE },
  "child-implementation": {
    path: "/mcp/child-implementation",
    families: CHILD_IMPLEMENTATION,
  },
};

export const sessionEndpointKey = (session: SessionToolProfile | undefined): SessionEndpointKey => {
  if (session === undefined) return "control";
  if (session.delegated === true) {
    if (session.agentRole === "ui-verifier") return "child-ui-verifier";
    switch (session.toolProfile) {
      case "phi":
        return "child-preview";
      case "implementation":
      case "implementation-phi":
        return "child-implementation";
      case "web-research":
        return "child-research";
      default:
        return "child-reader";
    }
  }
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

/** The families an endpoint lists. Adapters read it so instructions describe only listed tools. */
export const sessionToolFamilies = (
  session: SessionToolProfile | undefined,
): ReadonlySet<ToolFamily> => SESSION_TOOL_ENDPOINTS[sessionEndpointKey(session)].families;

export const isToolListedForSession = (
  name: string,
  session: SessionToolProfile | undefined,
): boolean => sessionToolFamilies(session).has(toolFamily(name));
