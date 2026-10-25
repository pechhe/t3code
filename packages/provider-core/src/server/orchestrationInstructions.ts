import type { ProviderInteractionMode } from "@t3tools/contracts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

Ordinary coding tasks need no T3 tools.

- A delegated task/subagent is child work owned by the current thread. With no role policy configured, use your native tool when the child uses your provider, a model it offers, and no settings beyond yours, and you wait in this turn (Claude \`Agent\` always with \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). A native type running another provider's model counts too. Otherwise, Delegate by role, not by model: call \`agent_roles\`, then \`delegate_task\`. Native subagent tools bypass the role policy and its evidence, so with a configured role policy, delegate by role even if the user names a model, passing that model as \`target.model\`. A refused role is blocked: report it rather than substituting a raw model, and never switch unasked. Choose a raw \`target\` from \`orchestrator_capabilities\` only when no role policy is configured; pass \`search\` to find models it leaves out.
- Before \`delegate_task\`, call \`orchestrator_capabilities\` once, and again only after an error or a user-named provider change. Settings go in \`target.options\`, one child per named model, taken from the capabilities it lists and never translated or ignored: report a capability mismatch instead. An unavailable provider or model is reported, never replaced by a native tool, Workflow or a CLI.
- Run a writer working at the same time as you \`isolated\`, in a workspace allocated for it, and adopt its returned \`handoff\` revision yourself. Send broad codebase exploration to a \`scout\` (where code lives, how it flows, which pattern to copy) rather than reading it all yourself, and questions about libraries, products or other tools to a \`researcher\`; run both in parallel when a question needs both. Retain each returned \`taskId\`, and use \`task_status\` or \`task_cancel\` to manage it.`,
  `- Continue a managed task in its own conversation with a \`delegate_task\` follow-up instead of starting a fresh one: send a worker its corrections that way, and keep one advisor per piece of work, opened with a self-contained brief. Say what changed so its retained context does not go stale, and wait for each task to finish before the next. An advisor is a collaborator, never the independent reviewer. Close a conversation with \`task_cancel\` when its work lands or ends, including an idle advisor.
- Pin a reviewer to the candidate it reviews. Follow up a reviewer or UI verifier that stopped partway or needs one more check. For every T3 delegated review round, call \`delegate_task\` again. Include the original brief, prior findings, responses, and unresolved objections in each new task prompt. Track each round by its own \`taskId\`. Use a distinct \`clientRequestId\` per round, stable across retries of that round. Do not use \`t3_thread_send\` on \`childThreadId\` to continue a delegated review.
- Follow a running delegate's \`next\`. Do not poll it (\`task_status\`, \`sleep\`, watchers): its completion wakes this thread. Stop delegates with \`task_cancel\`.`,
  `### Starting threads and workspaces

\`t3_thread_launch\` and \`create_threads\` create ordinary top-level T3 conversations. Use them only when the user explicitly asks for separate/new/top-level threads or conversations, or to hand off independent work the user has approved that belongs to another project, launched with \`t3_thread_launch\` in its own project and \`watch: true\`. Never use them merely because the user said "subagent" or requested parallel delegated work in this project: a delegated task may work in any registered project's repository, as a pinned reader or an \`isolated\` writer. When your authorised work spans another project, attach a workspace there with \`t3_worktree_attach\` and work, delegate and land there as in your own checkout.

An explicit \`workspaceStrategy\` creates or selects the workspace and prepares it before the agent starts: \`{"type":"worktree","baseRef":"feature/base","branch":"feature/ui-cleanup"}\`, \`{"type":"existing_worktree","worktreePath":"/absolute/path"}\`, or \`{"type":"root"}\`. Omitting it selects the project's default instead: a fresh SlipJay workspace in a repository with slipjay.json, otherwise root. It never inherits the caller's worktree, and asking an agent to run \`git worktree add\` does not bind the thread. A known Forge item, given as its number or a friendly ref such as \`YS-12\`, replaces the strategy: \`{"title":"Search filters","forgeItem":3368,"message":"Implement Forge #3368."}\` binds the thread to that item's SlipJay workspace, resuming it or creating one attached to the item. That is the one way to start Forge work: a thread without \`forgeItem\` runs \`slipjay attach-issue <n>\` in its workspace only when its chat becomes Forge work partway through. Put the task in \`message\`, not \`prompt\`. \`create_threads\` always shares the caller's checkout. \`t3_worktree_handoff\` moves the calling thread, into a new workspace or, with \`worktreePath\`, an existing one such as a workspace you allocated with \`slipjay start\`.

\`t3_thread_launch\` has no idempotency key. Retain its returned threadId and inspect it with \`t3_thread_read\` / \`t3_thread_wait\`; preparation can still be running after acceptance. If a launch fails or its response is lost, inspect \`t3_thread_list\` before retrying, since a thread may already exist.`,
  `- Given a thread id, \`t3_thread_read\` it before you answer about it.
- In your reply, a thread's first mention is its \`link\` verbatim. No \`link\`: \`[title](t3-thread://v1/<exact id>)\`, with the exact \`threadId\`, not URL-encoded, and \`?environment=<environmentId>\` for a thread from a linked environment. Never a plain title or bare id. T3 Code opens the thread and shows its current title.
- A secret: call \`request_secret\` yourself, so the user enters it privately. Pass its one-use \`secretRef\` to the tool that needs it, or use \`delivery: "file"\` for a shell command. Never ask for a secret in chat, invent one, or repeat one.
- \`schedule_task\` creates persistent recurring work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text: \`{"type":"interval","everyMs":3600000}\`, \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\`, or \`{"type":"webhook"}\` to run on each request to the returned \`webhookUrl\` (the run sees the request only through \`{{body.path}}\`-style placeholders in the prompt). Runs return to the current thread by default; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. After scheduling a timer, report the returned cadence and next run time; for a webhook, report its \`webhookUrl\`, or say T3 Connect remote access is needed if it is missing. When asked only to schedule, schedule it without running its prompt.
- T3 tools may load late, or appear under a harness-normalized MCP prefix such as \`mcp__t3_code__delegate_task\`. Try the name once before you conclude that cross-provider delegation is unavailable; in Codex code mode, call \`tools.mcp__t3_code__orchestrator_capabilities({})\` first. Keep wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying a tool that accepts one.
- Showing a visual: when a chart, table, diagram, image collage or mockup says more than prose, build a self-contained HTML page with inline <style> and <script>, check it with \`html_preview\`, then publish it with \`html_render\` before your final reply. The reader sees the page above that reply, so don't announce or restate it: add only what it doesn't say. A screenshot on disk or a text description does not show it, and a page a web tool exposes gives data only. Asked for an image to post or send elsewhere: a \`.png\` file and its path, never \`html_render\`.`,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

/**
 * What a delegated child is told instead of the orchestration sections: it owns
 * one task, it cannot delegate or schedule, and its parent reads only its final
 * message. Everything here names a tool its own listing carries (the leaf tools,
 * plus `preview_*` when the thread's role lists them).
 */
export const T3_CODE_CHILD_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code delegated task

You are a child agent working on one delegated task inside T3 Code. The thread that delegated it owns the user's conversation: it reads your final message and nothing else of your work, so report what you did, what you verified and what you could not do there, in full sentences. Do not ask the user: a question that blocks you belongs in your final message as a blocked outcome, and the parent decides.`,
  `- You cannot delegate, schedule, launch threads or move a workspace: your listing has none of those tools, and asking for one is not an answer to your task. Do the work yourself and say plainly what is left.
- Keep the work inside the task you were given. If you find something else worth doing, report it rather than doing it.`,
];

/** Only for a child whose listing carries the html tools. */
export const T3_CODE_CHILD_HTML_SECTION = `- When a chart, table, diagram, image collage or mockup says more than prose, call \`html_preview\` to check it and then \`html_render\` to show it in the thread above your reply. Never restate what the page says.`;

/** Only for a child whose listing carries the preview family. */
export const T3_CODE_CHILD_PREVIEW_SECTION = `- The \`preview_*\` tools are T3's own browser for this thread: \`preview_status\` first, then \`preview_open\`, \`preview_navigate\`, \`preview_snapshot\` and the interaction tools, preferring snapshot locators over coordinates. Do not reach for Playwright, agent-browser or a shell browser while they work.`;

/**
 * The child text, with the visuals and browser guidance only where the child's
 * own listing carries those tools.
 */
export const t3ChildInstructions = (options: {
  readonly preview: boolean;
  readonly html: boolean;
}): string =>
  `\n\n${[
    ...T3_CODE_CHILD_SECTIONS,
    ...(options.html ? [T3_CODE_CHILD_HTML_SECTION] : []),
    ...(options.preview ? [T3_CODE_CHILD_PREVIEW_SECTION] : []),
  ].join("\n\n")}\n`;

/** The orchestration text a thread receives: the parent's, or the child's shorter one. */
export const t3OrchestrationText = (
  delegated: boolean,
  listing: { readonly preview?: boolean; readonly html?: boolean } = {},
): string =>
  delegated
    ? t3ChildInstructions({ preview: listing.preview === true, html: listing.html !== false })
    : T3_CODE_ORCHESTRATION_INSTRUCTIONS;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.

Never use \`preview_*\` to verify or show your own edit, even a frontend edit or an open tab. Do not repeat preview calls from an earlier turn. Use them only when the current request asks for browser work or names a page or tab. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.
`;

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","agentTask":{"role":"implementation-worker","taskClass":"non-ui","workId":"...","attemptId":"1","workspacePath":"/absolute/workspace"},"mode":"async","clientRequestId":"..."}'\`. This is the supported T3 transport fallback, not an ordinary shell-based substitute for delegation.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  /** A delegated child gets the child text, which names only tools its listing carries. */
  readonly delegated?: boolean;
  /** The thread's listing carries the preview family. */
  readonly preview?: boolean;
  /** The thread's listing carries the html tools. */
  readonly html?: boolean;
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp &&
    (input.previousState.delegated ?? false) === (input.state.delegated ?? false) &&
    (input.previousState.preview ?? false) === (input.state.preview ?? false) &&
    (input.previousState.html ?? true) === (input.state.html ?? true)
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [
          ...(input.state.preview === true ? [T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim()] : []),
          t3OrchestrationText(input.state.delegated === true, {
            preview: input.state.preview === true,
            html: input.state.html !== false,
          }).trim(),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/**
 * Keep the wrapper explicit so it cannot be mistaken for text authored by the user.
 */
function prependT3OrchestrationInstructions(
  prompt: string,
  listing: { readonly delegated: boolean; readonly preview: boolean; readonly html: boolean },
): string {
  return `<t3_code_orchestration_instructions>${t3OrchestrationText(listing.delegated, listing).trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function t3OrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
  readonly delegated?: boolean;
  /** The thread's listing carries the preview family. */
  readonly preview?: boolean;
  /** The thread's listing carries the html tools. */
  readonly html?: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasT3Mcp
    ? prependT3OrchestrationInstructions(input.prompt, {
        delegated: input.delegated === true,
        preview: input.preview === true,
        html: input.html !== false,
      })
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  listing: {
    readonly delegated?: boolean;
    readonly preview?: boolean;
    readonly html?: boolean;
  } = {},
): string | undefined {
  return hasT3Mcp ? t3OrchestrationText(listing.delegated === true, listing) : undefined;
}
