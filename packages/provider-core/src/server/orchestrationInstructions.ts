import type { ProviderInteractionMode } from "@t3tools/contracts";
import { t3ChildInstructions } from "./delegatedChildInstructions.ts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
const orchestrationSections: ReadonlyArray<string> = [
  `## T3 Code orchestration

Ordinary coding tasks need no T3 tools.

- Available presets: scout maps code and checks external sources, browser drives pages, reviewer independently checks work, implementer writes code, and advisor helps a solo lead with a consequential problem. Presets provide guidance; execution authority is read-only or interactive (editor). Delegate when the expected benefit justifies briefing and integration: call \`agent_roles\`, choose by notes, effort, availability and user guidance, not pool order, then \`delegate_task\` with \`agentTask\` and \`target.model\`. One writing role, \`implementer\`: with \`forgeItem\` it owns that whole Spec in its own workspace and lands it, and only a top-level thread hands one out; without, it builds a piece in your workspace and you land it. Honour user-named models; multi-model roles require a choice, a sole model may be inferred. Workflows need a request. Never substitute unasked. Use \`offPolicyReason\` only as a last resort for a user-forced off-list model, all role models unavailable, or no fitting role. Only without role policy, choose a raw \`target\` from \`orchestrator_capabilities\`; \`search\` finds omitted models.
- Only without role policy, call \`orchestrator_capabilities\` once per thread before the first \`delegate_task\`, and again only after an error or a user-named provider change. Settings go in \`target.options\`, one child per named model, taken from the capabilities it lists and never translated or ignored: report a capability mismatch instead. An unavailable provider or model is reported, never replaced by a native tool, Workflow or a CLI. Never make a child's checkout in the shell or in \`task\`.
- A writer you delegate works in your workspace beside you by default: leave \`agentTask.workspaceAssignment\` unset, allocate no workspace, settle what the pieces share first, split by responsibility and commit the result yourself. Run one \`isolated\`, in a workspace allocated for it, only for an attempt you may discard, competing attempts at one thing, work needing its own server or database, a helper in another repository, or a worker fixing something outside your current work; adopt its returned \`handoff\` revision yourself. Send broad codebase exploration (where code lives, how it flows, which pattern to copy) and questions about libraries, products or other tools to a \`scout\` rather than reading it all yourself, when the separate investigation justifies the overhead. Keep narrow lookups and coupled work local. Brief the outcome, known decisions, scope and done-condition so the child can start without reconstructing your context. Retain each returned \`taskId\`, and use \`task_status\` or \`task_cancel\` to manage it.`,
  `- Continue a managed task in its own conversation with a \`delegate_task\` follow-up instead of starting a fresh one: send a worker its corrections that way, or steer it with \`t3_thread_send\` while it runs, and keep one advisor per piece of work, opened with a self-contained brief. Say what changed so its retained context does not go stale, and wait for that task to finish before following it up. Delegated workers normally consult their immediate parent; advisors primarily help solo leads. An advisor is a collaborator, never the independent reviewer. Send an interim message only when it changes another agent's work; no acknowledgement-only replies. After repeated clarification without progress, repair the brief or decide the issue instead of exchanging more paraphrases. Leave a completed advisor or helper open for \`delegate_task\` follow-ups. Do not call \`task_cancel\` after reading its result, because \`task_cancel\` permanently closes the task and blocks follow-ups (T3 closes idle advisors automatically). Use \`task_cancel\` only to stop a running delegate you replace or no longer need.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`t3_thread_send\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- Pin a reviewer to the candidate it reviews. Follow up a reviewer or browser task that stopped partway or needs one more check. Send each later review round to the same reviewer as a follow-up with the new \`sourceRevision\` and what changed. If it is gone or retired, give a fresh one the brief, prior findings, responses and objections. Use a distinct \`clientRequestId\` per round, stable across retries of that round. Do not use \`t3_thread_send\` on \`childThreadId\` to continue a delegated review.
- Follow a running delegate's \`next\`. Do not poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup): its completion wakes this thread. Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on a \`childThreadId\`.
- Delegation goes two levels below a top-level thread. At that limit, \`delegate_task\`, \`t3_thread_launch\` and \`schedule_task\` refuse: do the work yourself.`,
  `### Advice

Use \`ask_advice\` for consequential uncertainty after investigation, materially ambiguous intent, conflicts with the brief, or shared contracts and sibling work. A delegated worker defaults to its actual parent, which already holds wider context; parent is a destination, never a model. A top-level thread must select \`destination:"advisor"\` explicitly, using existing managed advisor admission (sourceRevision pins a checkout). Advice grants no authority and is separate from independent review and human approvals. Decide routine reversible implementation details locally. Bundle related questions with the investigation and your recommendation in the question or optional evidence fields. blocking defaults true; set false when independent work can continue. Reuse the request identity only for identical retries; follow up an answered request only with a fresh identity and nonempty new evidence or unresolved point. A pending blocking request yields control: end the turn, and the answer wakes the worker; nonblocking workers continue independent work.`,
  `### Starting threads and workspaces

\`t3_thread_launch\` creates ordinary top-level T3 conversations. Use it only when the user explicitly asks for separate/new/top-level threads or conversations, or to hand off independent work the user has approved that belongs to another project, launched with \`t3_thread_launch\` in its own project and \`watch: true\`. Never use it merely because the user said "subagent" or requested parallel delegated work in this project: a delegated task may work in any registered project's repository, as a pinned reader or an \`isolated\` writer. When your authorised work spans another project, attach a workspace there with \`t3_worktree_attach\` and work, delegate and land there as in your own checkout. From inside a thread, also say in \`whyNotDelegated\` why this must be its own thread and not a \`delegate_task\` child, including a whole Spec in another project; a call without that reason is refused before anything is created.

An explicit \`workspaceStrategy\` creates or selects the workspace and prepares it before the agent starts: \`{"type":"worktree","baseRef":"feature/base","branch":"feature/ui-cleanup"}\`, \`{"type":"existing_worktree","worktreePath":"/absolute/path"}\`, or \`{"type":"root"}\`. Omitting it selects the project's default instead: a fresh SlipJay workspace in a repository with slipjay.json, otherwise root. It never inherits the caller's worktree, and asking an agent to run \`git worktree add\` does not bind the thread. A known Forge item, given as its number or a friendly ref such as \`YS-12\`, replaces the strategy: \`{"title":"Search filters","forgeItem":3368,"message":"Implement Forge #3368."}\` binds the thread to that item's SlipJay workspace, resuming it or creating one attached to the item. That is the one way to start Forge work: a thread without \`forgeItem\` runs \`slipjay attach-issue <n>\` in its workspace only when its chat becomes Forge work partway through. Put the task in \`message\`, not \`prompt\`. \`t3_worktree_handoff\` moves the calling thread, into a new workspace or, with \`worktreePath\`, an existing one such as a workspace you allocated with \`slipjay start\`.

Reuse a stable \`clientRequestId\` for a retry of \`t3_thread_launch\`. Retain its returned threadId and inspect it with \`t3_thread_read\` / \`t3_thread_wait\`; preparation can still be running after acceptance. If a launch fails or its response is lost, inspect \`t3_thread_list\` before retrying, since a thread may already exist.

- Honor a requested base. Otherwise independent work uses the default branch as \`remote/branch\` with \`startFromOrigin:true\`; with no remote, use the local default. Required unpublished commits and dependent work use their local base. A shell worktree does not bind a launch, and no checkout setup in its prompt.`,
  `- Given a thread id, \`t3_thread_read\` it before you answer about it. Change, organize, configure, fork or move a thread with \`t3_thread_update\`'s \`action\`; asked to settle a thread, this one too: \`action: "settle"\`.
- In your reply, mention a thread by its \`link\`, verbatim. Never a plain title or bare id.
- Secrets: use existing service connections, then \`search_secrets\` to find saved BWS keys by name. Reuse their ID with \`request_secret\`, storage "bws". If genuinely missing, request a secure card: storage "bws" and secretKey for reusable credentials; storage "temporary" for OTPs, pairing codes and sudo. Never ask in chat or print values. A store outage is not a missing key. Replace only an explicitly selected ID through the card; \`delete_secret\` needs explicit user authority, never task cleanup. Browser-login keys use the saved browser binding. Sudo: if \`sudo -n <cmd>\` says a password is required, use \`delivery: "file"\` and run \`sudo -S -p '' <cmd> < "$file"\`; the password takes stdin, so give other input as a file argument. When asked only to schedule, \`schedule_task\` without running its prompt.
- To wait on something (another thread, a Forge item, a landing, a commit reaching Production, a time), call \`watch\` with \`expectedMinutes\` and a \`note\`, then end your turn: T3 wakes the thread; a time is \`{kind:"time", at}\`. Never a background sleep, a poll or a one-off scheduled task. Ending a turn on a question only your owner can answer: also \`watch\` \`{kind:"owner", question}\`, so they see it.
- \`schedule_task\` creates persistent recurring work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text: \`{"type":"interval","everyMs":3600000}\`, \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\`, or \`{"type":"webhook"}\` to run on each request to the returned \`webhookUrl\` (the run sees the request only through \`{{body.path}}\`-style placeholders in the prompt). Runs return to the current thread by default; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. After scheduling a timer, report the returned cadence and next run time; for a webhook, report its \`webhookUrl\`, or say T3 Connect remote access is needed if it is missing. When asked only to schedule, schedule it without running its prompt.
- T3 tools may load late, or appear under a harness-normalized MCP prefix such as \`mcp__t3_code__delegate_task\`. Try the name once before you conclude that cross-provider delegation is unavailable; in Codex code mode, call \`tools.mcp__t3_code__orchestrator_capabilities({})\` first. Keep wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying a tool that accepts one.`,
  `### Visuals and preview

- Answer data with a trend or comparison with a chart, and show any visual the user asks for here: pass the path to an HTML file, or inline HTML to \`html_preview\`, then \`html_render\` before your final reply. The reader sees the page above that reply, so don't announce or restate it: add only what it doesn't say. A screenshot on disk or a text description does not show it. Never start a server for it. Page tools write only on user request. Never use them to show results. Asked for an image to post, send, or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- When browser work needs a script (loops over many pages, page code, timings taken in the page, a check to re-run), write it for \`t3 browser run <file>\` on T3's headless browser (see its \`--help\`), never Playwright or another browser in the shell. Looking at pages or walking a flow stays with \`browser_*\`.`,
];

export const T3_CODE_ORCHESTRATION_SECTIONS = orchestrationSections;

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

/** The orchestration text a thread receives: the parent's, or the child's shorter one. */
export const t3OrchestrationText = (
  delegated: boolean,
  listing: {
    readonly preview?: boolean;
    readonly html?: boolean;
    readonly hasDeviceTools?: boolean;
  } = {},
): string => {
  const instructions = delegated
    ? t3ChildInstructions({ preview: listing.preview === true, html: listing.html !== false })
    : T3_CODE_ORCHESTRATION_INSTRUCTIONS;
  return listing.hasDeviceTools
    ? `${instructions}\n${T3_CODE_DEVICE_TOOL_INSTRUCTIONS}\n`
    : instructions;
};

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code browser

When browser work was asked, \`browser_*\` is your browser, on the backend your task chose: \`browser_open\` a tab, \`browser_snapshot\` to read it, \`browser_act\` to drive it in batched steps with snapshot locators rather than coordinates, \`browser_page_tools\` first when the page offers its own tools, \`browser_close\` when done. Switch browsers only if the tools are absent or \`browser_open\` says unsupported, the user asks, or two calls fail on one step. Then quote the error and switch.

Do not repeat browser calls from an earlier turn. Public pages: web fetch or search unless browser work was asked; then browser tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.
`;

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## T3 Code devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device over ssh only when the user explicitly asks. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session; if it still fails, tell the user and stop, unless they explicitly asked you to drive it over ssh. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","agentTask":{"role":"implementer","taskClass":"non-ui","workId":"...","attemptId":"1"},"mode":"async","clientRequestId":"..."}'\`. This is the supported T3 transport fallback, not an ordinary shell-based substitute for delegation.`;

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
  readonly hasDeviceTools?: boolean;
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
    (input.previousState.html ?? true) === (input.state.html ?? true) &&
    input.previousState.hasDeviceTools === input.state.hasDeviceTools
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
          ...(input.state.hasDeviceTools ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS] : []),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

function prependT3OrchestrationInstructions(prompt: string, instructions: string): string {
  return `<t3_code_orchestration_instructions>${instructions.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function t3OrchestrationPrompt(input: {
  readonly prompt: string;
  readonly hasT3Mcp: boolean;
  readonly delegated?: boolean;
  /** The thread's listing carries the preview family. */
  readonly preview?: boolean;
  /** The thread's listing carries the html tools. */
  readonly html?: boolean;
  readonly hasDeviceTools: boolean;
  readonly orchestrationDelivered: boolean;
  readonly deviceInstructionsDelivered: boolean;
}): string {
  if (!input.hasT3Mcp) return input.prompt;
  if (!input.orchestrationDelivered) {
    return prependT3OrchestrationInstructions(
      input.prompt,
      t3OrchestrationText(input.delegated === true, input),
    );
  }
  return input.hasDeviceTools && !input.deviceInstructionsDelivered
    ? prependT3OrchestrationInstructions(input.prompt, T3_CODE_DEVICE_TOOL_INSTRUCTIONS)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  listing: {
    readonly hasDeviceTools?: boolean;
    readonly delegated?: boolean;
    readonly preview?: boolean;
    readonly html?: boolean;
  } = {},
): string | undefined {
  return hasT3Mcp ? t3OrchestrationText(listing.delegated === true, listing) : undefined;
}
