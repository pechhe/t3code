import { WEAVE_NAMES } from "./weaveNames.ts";
import type { AgentRole, AgentToolProfile } from "./agentPolicy.ts";

/**
 * A set of T3 MCP tools one thread's harness may be shown. Listing is a
 * presentation decision: the capability checks on each call still decide what
 * the caller may do.
 */
export type ToolFamily =
  | "decision"
  | "control"
  | "workspace"
  | "scheduling"
  | "preview"
  | "bounded-browser"
  | "device"
  | "queue"
  | "worktree"
  | "project"
  | "experiments"
  | "lead-experiments"
  | "work"
  | "inspection"
  | "peer"
  | "leaf"
  | "report"
  | "learnings"
  | "web";

export interface SessionToolProfile {
  readonly toolProfile?: AgentToolProfile | undefined;
  readonly agentRole?: AgentRole | undefined;
  /** The task's recorded source access is read-only. Its class, whatever its role. */
  readonly readOnly?: boolean | undefined;
}

const LEAD_EXPERIMENT_TOOLS = new Set([
  "t3_experiments_list",
  "t3_experiments_results",
  "t3_experiments_create",
  "t3_experiments_transition",
]);

const SCHEDULING_TOOLS = new Set([
  "schedule_task",
  "list_scheduled_tasks",
  "delete_scheduled_task",
  "run_scheduled_task_now",
]);

/**
 * The orchestration instructions tell an ordinary thread to move its workspace and
 * discover projects with these, so every profile that includes `control` lists them.
 */
const CONTROL_EXTRA_TOOLS = new Set([
  "create_threads",
  "t3_project_list",
  "t3_thread_move_to_project",
  "t3_thread_suggest_project",
]);

/** What every agent needs: poll or cancel its own task, watch something, and show the user a page. */
const LEAF_TOOLS = new Set([
  "task_status",
  "task_cancel",
  "watch",
  "unwatch",
  "html_preview",
  "html_render",
]);

/** The tool a managed agent reports its outcome with. */
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

const LEARNING_READ_TOOLS = new Set(["t3_champions_learning_search", "t3_champions_learning_read"]);

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
  if (name === "t3_decide") return "decision";
  if (name === "web_search" || name === "web_fetch") return "web";
  if (REPORT_TOOLS.has(name)) return "report";
  if (LEAF_TOOLS.has(name)) return "leaf";
  if (SCHEDULING_TOOLS.has(name)) return "scheduling";
  // Narrow web readers search Champion learnings too, so these stay apart from Champion writes.
  if (LEARNING_READ_TOOLS.has(name)) return "learnings";
  if (name.startsWith("t3_champions_")) return "scheduling";
  if (LEAD_EXPERIMENT_TOOLS.has(name)) return "lead-experiments";
  if (name.startsWith("t3_experiments_")) return "experiments";
  if (name.startsWith("t3_work_")) return "work";
  // Source inspection is for external OAuth clients; no session endpoint lists it.
  if (name.startsWith("workspace_")) return "inspection";
  // A linked environment's server calls this to hand a thread over; no agent session lists it.
  if (name === "t3_thread_import") return "peer";
  if (name.startsWith("preview_") || name.startsWith("t3_preview_")) return "preview";
  if (name.startsWith("t3_browser_")) return "bounded-browser";
  if (name.startsWith("device_")) return "device";
  if (name.startsWith("t3_queue_")) return "queue";
  if (CONTROL_EXTRA_TOOLS.has(name)) return "control";
  if (name.startsWith("t3_worktree_")) return "worktree";
  if (name.startsWith("t3_project_") || name === WEAVE_NAMES.connectionTool) return "project";
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

/**
 * What a read-only agent may call, closed so a new tool starts refused: reads, its own task and
 * watches, showing a page, Champion learnings, a granted bounded browser, and delegating read-only
 * roles (`delegate_task` checks the role). `McpHttpServer` applies it to listing and calling.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "watch_pull_request",
  "unwatch_pull_request",
  "agent_roles",
  "agent_task_outcome",
  "delegate_task",
  "html_preview",
  "html_render",
  "list_scheduled_tasks",
  "list_thread_pull_requests",
  "orchestrator_capabilities",
  "read_pull_request_guide",
  "t3_background_wait",
  "t3_browser_close",
  "t3_browser_open",
  "t3_browser_snapshot",
  "t3_browser_status",
  "t3_browser_task",
  "t3_browser_task_cancel",
  "t3_champions_check_context",
  "t3_champions_class_choices",
  "t3_champions_get",
  "t3_champions_history",
  "t3_champions_learning_read",
  "t3_champions_learning_search",
  "t3_champions_list",
  "t3_champions_record_learning",
  "t3_environment_links",
  "t3_environment_read",
  "t3_experiments_list",
  "t3_experiments_read_evidence",
  "t3_experiments_results",
  "t3_fleet_summary",
  "t3_project_list",
  "t3_project_read",
  "t3_terminal_read",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_search",
  "t3_thread_wait",
  "t3_video_frames",
  "t3_work_read",
  "t3_worktree_list",
  "t3_worktree_status",
  "task_cancel",
  "task_status",
  "unwatch",
  "watch",
]);

/** Everything an agent session can use; `inspection` and `peer` serve outside clients and links. */
const EDITOR: ReadonlySet<ToolFamily> = new Set([
  "decision",
  "control",
  "workspace",
  "scheduling",
  "preview",
  "bounded-browser",
  "device",
  "queue",
  "worktree",
  "project",
  "experiments",
  "lead-experiments",
  "work",
  "leaf",
  "report",
  "learnings",
  "web",
]);
/** The toolkits the read-only list draws from; `READ_ONLY_TOOLS` picks within them. */
const READER: ReadonlySet<ToolFamily> = new Set([
  "control",
  "workspace",
  "scheduling",
  "bounded-browser",
  "worktree",
  "project",
  "experiments",
  "lead-experiments",
  "work",
  "leaf",
  "report",
  "learnings",
]);
/**
 * Agents that read untrusted web pages stay narrow, because a page could otherwise steer them
 * into reading threads and sending them out.
 */
const RESEARCH: ReadonlySet<ToolFamily> = new Set(["learnings", "leaf", "report", "web"]);
const PREVIEW: ReadonlySet<ToolFamily> = new Set([
  "learnings",
  "decision",
  "leaf",
  "report",
  "preview",
  "device",
]);

export type SessionEndpointKey = "editor" | "reader" | "research" | "preview";

/**
 * The one policy table: each endpoint's path and the families its `tools/list` serves. A thread
 * with no task, and every task that may write, is an editor.
 */
export const SESSION_TOOL_ENDPOINTS: Readonly<
  Record<SessionEndpointKey, { readonly path: string; readonly families: ReadonlySet<ToolFamily> }>
> = {
  editor: { path: "/mcp/editor", families: EDITOR },
  reader: { path: "/mcp/reader", families: READER },
  research: { path: "/mcp/research", families: RESEARCH },
  preview: { path: "/mcp/preview", families: PREVIEW },
};

export const sessionEndpointKey = (session: SessionToolProfile | undefined): SessionEndpointKey => {
  if (session?.toolProfile === "phi") return "preview";
  if (session?.toolProfile === "web-research") return "research";
  return session?.readOnly === true ? "reader" : "editor";
};

/** The families an endpoint lists. Adapters read it so instructions describe only listed tools. */
export const sessionToolFamilies = (
  session: SessionToolProfile | undefined,
): ReadonlySet<ToolFamily> => SESSION_TOOL_ENDPOINTS[sessionEndpointKey(session)].families;

export const isToolListedForSession = (
  name: string,
  session: SessionToolProfile | undefined,
): boolean =>
  (toolFamily(name) !== "decision" || canUseDecisions(session)) &&
  sessionToolFamilies(session).has(toolFamily(name)) &&
  (sessionEndpointKey(session) !== "reader" || READ_ONLY_TOOLS.has(name));

export const canUseDecisions = (session: SessionToolProfile | undefined): boolean => {
  if (session?.toolProfile === "source-reader" || session?.toolProfile === "web-research")
    return false;
  if (["scout", "advisor", "reviewer", "researcher"].some((role) => role === session?.agentRole))
    return false;
  return (
    session?.toolProfile === undefined ||
    ["implementation", "phi"].some((profile) => profile === session.toolProfile)
  );
};
