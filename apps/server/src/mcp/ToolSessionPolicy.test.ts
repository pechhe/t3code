import {
  isToolListedForSession,
  SESSION_TOOL_ENDPOINTS,
  sessionEndpointKey,
  sessionToolFamilies,
  toolFamily,
  type SessionToolProfile,
} from "@t3tools/contracts";
import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3OrchestrationText,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { claudeMcpQueryOverrides } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  codexThreadRuntimeParams,
  codexTurnInstructionListing,
} from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { buildCodexAdditionalContext } from "../provider/CodexDeveloperInstructions.ts";
import {
  NO_PROJECT_NOTE,
  unreplacedWorkspaceNote,
} from "../orchestration-v2/ProviderTurnStartService.ts";
import { buildPiRpcLaunch } from "../../../../packages/provider-pi/src/server/mcpInjection.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { DeviceToolkit } from "./toolkits/device/tools.ts";
import { ExperimentsToolkit } from "./toolkits/experiments/tools.ts";
import { HtmlPreviewToolkit, HtmlRenderToolkit } from "./toolkits/html/tools.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { FleetToolkit } from "./toolkits/fleet/tools.ts";
import { TerminalToolkit } from "./toolkits/terminal/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { WorkspaceToolkit } from "./toolkits/workspace/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import { MANAGED_BROWSER_TOOL_NAMES } from "./toolkits/managedBrowser/toolNames.ts";

const tools = [
  ...Object.values(OrchestratorToolkit.tools),
  ...Object.values(PreviewToolkit.tools),
  ...Object.values(DeviceToolkit.tools),
  ...Object.values(ExperimentsToolkit.tools),
  ...Object.values(HtmlPreviewToolkit.tools),
  ...Object.values(HtmlRenderToolkit.tools),
  ...Object.values(AttachmentToolkit.tools),
  ...Object.values(EnvironmentToolkit.tools),
  ...Object.values(FleetToolkit.tools),
  ...Object.values(TerminalToolkit.tools),
  ...Object.values(PreviewControlsToolkit.tools),
  ...Object.values(ProjectToolkit.tools),
  ...Object.values(PullRequestsToolkit.tools),
  ...Object.values(ThreadToolkit.tools),
  ...Object.values(WorktreeToolkit.tools),
];

const names = (session: SessionToolProfile | undefined) =>
  new Set<string>(
    tools.filter((tool) => isToolListedForSession(tool.name, session)).map((tool) => tool.name),
  );

const payloadChars = (session: SessionToolProfile | undefined) =>
  tools
    .filter((tool) => isToolListedForSession(tool.name, session))
    .reduce(
      (total, tool) =>
        total +
        (Tool.getDescription(tool) ?? "").length +
        JSON.stringify(Tool.getJsonSchema(tool)).length,
      0,
    );

const session = (
  toolProfile: SessionToolProfile["toolProfile"],
  agentRole?: SessionToolProfile["agentRole"],
  delegated = false,
) => ({ toolProfile, agentRole, delegated }) satisfies SessionToolProfile;

// These ceilings catch the ~190k catalogue coming back, not a tool the thread's
// own instructions name: the handoff family is part of the control plane and the
// html tools are counted here. A delegated child lists its own work family and
// the leaf tools only, so its ceiling is the reason it cannot drift back to the
// control plane. Each number is the payload that endpoint committed to: a change that
// needs a higher one states the new number and what bought it.
const budgets: ReadonlyArray<[string, SessionToolProfile | undefined, number]> = [
  // 39,994 measured.
  ["ordinary", undefined, 40_000],
  // The preview endpoint is a browser session's listing, so it carries no control plane.
  // 32,741 measured; the ceiling moved by 100 for the theme guide's corrected code-variable
  // names, which the html tools carry on this endpoint too.
  ["browser/preview", session("phi", "browser"), 32_800],
  ["ui-verifier", session("phi", "ui-verifier"), 120_000],
  ["ui-worker", session("implementation-phi", "ui-worker"), 115_000],
  ["researcher", session("web-research", "researcher"), 105_000],
  ["scout", session("source-reader", "scout"), 90_000],
  ["delegated browser", session("phi", "browser", true), 40_000],
  ["delegated ui-verifier", session("phi", "ui-verifier", true), 40_000],
  [
    "delegated implementation-worker",
    session("implementation", "implementation-worker", true),
    45_000,
  ],
  ["delegated researcher", session("web-research", "researcher", true), 25_000],
  ["delegated scout", session("source-reader", "scout", true), 15_000],
  ["delegated reviewer", session("source-reader", "ticket-reviewer", true), 15_000],
];

it("keeps every session endpoint under its payload budget", () => {
  for (const [label, profile, ceiling] of budgets) {
    expect(payloadChars(profile), `${label} payload chars`).toBeLessThan(ceiling);
  }
});

it("lists a browser session only the families it uses", () => {
  // The preview is what the session is for; leaf gives it its own task status, cancel,
  // watch and the html tools to show the user a page, and report its outcome. A later
  // family added here fails this test rather than quietly raising the budget.
  expect([...SESSION_TOOL_ENDPOINTS.preview.families].sort()).toEqual([
    "leaf",
    "preview",
    "report",
  ]);
});

const toolsNamedIn = (text: string) =>
  // Bare names too: the SlipJay workspace notes name tools without backticks.
  tools.map((tool) => tool.name).filter((name) => new RegExp(`\\b${name}\\b`).test(text));

/**
 * Every endpoint a thread can be given, with the text that thread receives. The
 * flags are the ones the adapters read off the MCP session config, so this fails
 * when an instruction names a tool its own listing does not carry.
 */
const instructionCases: ReadonlyArray<[string, SessionToolProfile | undefined]> = [
  ["ordinary", undefined],
  // No parent browser session: a thread's profile and role come only from its agentTask,
  // and the preview endpoint no longer carries the control plane the parent text names.
  ["ui-verifier", session("phi", "ui-verifier")],
  ["ui-worker", session("implementation-phi", "ui-worker")],
  ["researcher", session("web-research", "researcher")],
  ["scout", session("source-reader", "scout")],
  ["delegated browser", session("phi", "browser", true)],
  ["delegated ui-verifier", session("phi", "ui-verifier", true)],
  ["delegated implementation-worker", session("implementation", "implementation-worker", true)],
  ["delegated researcher", session("web-research", "researcher", true)],
  ["delegated scout", session("source-reader", "scout", true)],
  ["delegated reviewer", session("source-reader", "ticket-reviewer", true)],
];

const textFor = (profile: SessionToolProfile | undefined) => {
  const families = sessionToolFamilies(profile);
  const delegated = profile?.delegated === true;
  return t3OrchestrationText(delegated, {
    preview: families.has("preview"),
    html: families.has("leaf"),
  });
};

it("lists every tool the instructions its threads receive name", () => {
  // Derived, so an instruction that names a tool an endpoint does not serve fails
  // here rather than in a thread whose agent has no way to comply.
  const parentText = [
    T3_CODE_ORCHESTRATION_INSTRUCTIONS,
    NO_PROJECT_NOTE,
    unreplacedWorkspaceNote("/tmp/checkout"),
  ].join("\n");
  const parentNamed = toolsNamedIn(parentText);
  expect(parentNamed).toContain("t3_worktree_handoff");
  expect(
    parentNamed.filter((name) => !isToolListedForSession(name, undefined)),
    "ordinary instructions name listed tools",
  ).toEqual([]);

  for (const [label, profile] of instructionCases) {
    const unlisted = toolsNamedIn(textFor(profile)).filter(
      (name) => !isToolListedForSession(name, profile),
    );
    expect(unlisted, `${label} instructions name listed tools`).toEqual([]);
  }

  // A child text must not send a child at the parent's plane.
  const childNamed = new Set(
    toolsNamedIn(t3OrchestrationText(true, { preview: true, html: true })),
  );
  for (const name of [
    "delegate_task",
    "schedule_task",
    "t3_thread_launch",
    "create_threads",
    "t3_worktree_handoff",
  ] as const) {
    expect(childNamed.has(name), `child text does not name ${name}`).toBe(false);
  }
  expect(childNamed.has("html_render")).toBe(true);
});

it("tells a narrow browser child about preview only, and that listing is all preview", () => {
  // A ui-worker keeps the managed-browser endpoint, whose credential serves Phi's
  // operations and nothing else, so its child text must not name html or worktree.
  const narrow = t3OrchestrationText(true, { preview: true, html: false });
  const narrowNamed = new Set(toolsNamedIn(narrow));
  expect(narrowNamed.has("preview_open")).toBe(true);
  expect(narrowNamed.has("html_render")).toBe(false);
  expect(narrowNamed.has("t3_worktree_handoff")).toBe(false);

  for (const name of MANAGED_BROWSER_TOOL_NAMES) {
    expect(toolFamily(name), `${name} is a preview tool`).toBe("preview");
  }
});

it("lists the preview family only for Phi profiles, and device only for a UI verifier", () => {
  const ordinary = names(undefined);
  expect(ordinary.has("preview_interact")).toBe(false);
  expect(ordinary.has("preview_open")).toBe(false);
  expect(ordinary.has("device_open")).toBe(false);
  expect(ordinary.has("t3_experiments_list")).toBe(false);
  expect(ordinary.has("t3_worktree_status")).toBe(true);
  expect(ordinary.has("html_render")).toBe(true);
  expect(ordinary.has("t3_thread_move_to_project")).toBe(true);
  expect(ordinary.has("create_threads")).toBe(true);
  expect(ordinary.has("link_pull_request")).toBe(false);

  const browser = names(session("phi", "browser"));
  expect(browser.has("preview_interact")).toBe(true);
  expect(browser.has("device_open")).toBe(false);
  expect(browser.has("delegate_task")).toBe(false);
  expect(browser.has("t3_worktree_status")).toBe(false);
  expect(browser.has("agent_task_outcome")).toBe(true);

  const verifier = names(session("phi", "ui-verifier"));
  expect(verifier.has("preview_interact")).toBe(true);
  expect(verifier.has("device_open")).toBe(true);

  const worker = names(session("implementation-phi", "ui-worker"));
  expect(worker.has("preview_interact")).toBe(true);
  expect(worker.has("t3_worktree_status")).toBe(true);

  const researcher = names(session("web-research", "researcher"));
  expect(researcher.has("t3_experiments_list")).toBe(true);
  expect(researcher.has("preview_interact")).toBe(false);
});

it("gives a delegated child its own work family and the leaf tools, never the control plane", () => {
  const browser = names(session("phi", "browser", true));
  expect(browser.has("preview_interact")).toBe(true);
  expect(browser.has("html_render")).toBe(true);
  expect(browser.has("agent_task_outcome")).toBe(true);
  expect(browser.has("task_status")).toBe(true);
  for (const parentOnly of [
    "delegate_task",
    "schedule_task",
    "t3_thread_launch",
    "create_threads",
    "t3_thread_send",
    "t3_worktree_handoff",
    "link_pull_request",
    "t3_terminal_read",
  ]) {
    expect(browser.has(parentOnly), `browser child lists ${parentOnly}`).toBe(false);
  }

  const verifier = names(session("phi", "ui-verifier", true));
  expect(verifier.has("device_open")).toBe(true);

  const reader = names(session("source-reader", "scout", true));
  expect(reader.has("preview_interact")).toBe(false);
  expect(reader.has("agent_task_outcome")).toBe(true);

  const worker = names(session("implementation", "implementation-worker", true));
  expect(worker.has("t3_worktree_status")).toBe(true);
  expect(worker.has("preview_interact")).toBe(false);

  // The browser endpoint is a browser session's listing, so it carries no control plane: the
  // work an ordinary thread does to orchestrate belongs to the control endpoint alone.
  expect(names(session("phi", "browser")).has("delegate_task")).toBe(false);
});

it("hands all three harnesses the same session endpoint", () => {
  for (const profile of [
    undefined,
    session("phi", "browser"),
    session("implementation", "scout"),
  ]) {
    const key = sessionEndpointKey(profile);
    const endpoint = `http://127.0.0.1:43123${SESSION_TOOL_ENDPOINTS[key].path}`;
    const mcpSession = {
      environmentId: "environment-test" as never,
      threadId: "thread-test" as never,
      providerSessionId: "provider-session-test",
      providerInstanceId: "codex" as never,
      endpoint,
      authorizationHeader: "Bearer test-token",
      browserToolsAvailable: true,
    };

    const codex = codexThreadRuntimeParams({ mcpSession });
    const claude = claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: false,
    });
    const pi = buildPiRpcLaunch({
      launchArgs: [],
      environment: {},
      mcpSession,
      extensionPath: "/tmp/extension.ts",
    });

    const codexConfig = codex.config["mcp_servers.t3-code"] as { url: string };
    expect(codexConfig.url).toBe(endpoint);
    const claudeServer = claude.mcpServers?.["t3-code"];
    expect(claudeServer !== undefined && "url" in claudeServer ? claudeServer.url : undefined).toBe(
      endpoint,
    );
    expect(pi.env.T3_MCP_URL).toBe(endpoint);
    expect(pi.env.T3_MCP_BEARER_TOKEN).toBe("test-token");
  }
});

const instructionText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map(instructionText).join("\n")
      : value !== null && typeof value === "object"
        ? Object.entries(value)
            .map(([key, entry]) => (key === "kind" ? "" : instructionText(entry)))
            .join("\n")
        : "";

it("has Codex describe the listing, not the browser permission", () => {
  const runtime = { model: "gpt-6.1-sol" };
  type Listing = {
    readonly delegated?: boolean;
    readonly listsPreview?: boolean;
    readonly listsDevice?: boolean;
    readonly listsHtml?: boolean;
  };
  const sessionWith = (listing: Listing): McpProviderSession.McpProviderSessionConfig => ({
    environmentId: "environment-test" as never,
    threadId: "thread-test" as never,
    providerSessionId: "provider-session-test",
    providerInstanceId: "codex" as never,
    endpoint: "http://127.0.0.1:43123/mcp/child-reader",
    authorizationHeader: "Bearer test-token",
    // The project lets this agent browse; the reader endpoint still lists no
    // preview tool, and the instructions must follow the listing.
    browserToolsAvailable: true,
    ...listing,
  });

  const text = (listing: Listing) => {
    const mapped = codexTurnInstructionListing(sessionWith(listing));
    return instructionText(
      buildCodexAdditionalContext(
        runtime,
        {
          browser: mapped.listsPreview,
          device: mapped.listsDevice,
          ...(mapped.listsHtml === false ? { html: false } : {}),
        },
        mapped.delegated,
      ),
    );
  };

  const reader = text({
    delegated: true,
    listsPreview: false,
    listsDevice: false,
    listsHtml: true,
  });
  expect(reader).not.toContain("preview_open");
  expect(reader).not.toContain("device_open");
  expect(reader).toContain("html_render");
  expect(reader).not.toContain("delegate_task");

  const browser = text({ delegated: true, listsPreview: true, listsHtml: true });
  expect(browser).toContain("preview_open");
  expect(browser).not.toContain("device_open");
  expect(browser).not.toContain("delegate_task");

  // The narrow managed-browser credential: preview only, no html.
  const narrow = text({ delegated: true, listsPreview: true, listsHtml: false });
  expect(narrow).toContain("preview_open");
  expect(narrow).not.toContain("html_render");

  // A parent thread keeps the full orchestration text whatever its listing.
  expect(text({ listsPreview: true })).toContain("delegate_task");
});

it("gives Pi's process the child text its own listing earns", () => {
  const launch = (listing: {
    readonly delegated: boolean;
    readonly listsPreview: boolean;
    readonly listsHtml: boolean;
  }) =>
    buildPiRpcLaunch({
      launchArgs: [],
      environment: {},
      extensionPath: "/tmp/extension.ts",
      mcpSession: {
        environmentId: "environment-test" as never,
        threadId: "thread-test" as never,
        providerSessionId: "provider-session-test",
        providerInstanceId: "pi" as never,
        endpoint: "http://127.0.0.1:43123/mcp/child-preview",
        authorizationHeader: "Bearer test-token",
        browserToolsAvailable: true,
        ...listing,
      },
    });

  const reader = launch({ delegated: true, listsPreview: false, listsHtml: true });
  expect(reader.env.T3_PI_INSTRUCTIONS).toContain("html_render");
  expect(reader.env.T3_PI_INSTRUCTIONS).not.toContain("preview_open");
  expect(reader.env.T3_PI_INSTRUCTIONS).not.toContain("delegate_task");

  // The narrow browser credential: preview without html.
  const narrow = launch({ delegated: true, listsPreview: true, listsHtml: false });
  expect(narrow.env.T3_PI_INSTRUCTIONS).toContain("preview_open");
  expect(narrow.env.T3_PI_INSTRUCTIONS).not.toContain("html_render");

  // A parent thread keeps the embedded orchestration text.
  expect(
    launch({ delegated: false, listsPreview: true, listsHtml: true }).env.T3_PI_INSTRUCTIONS,
  ).toBeUndefined();
});

it("keeps workspace inspection off every session endpoint and its listing small", () => {
  const inspection = Object.values(WorkspaceToolkit.tools);
  expect(inspection.map((tool) => toolFamily(tool.name))).toEqual(
    inspection.map(() => "inspection"),
  );
  for (const endpoint of Object.values(SESSION_TOOL_ENDPOINTS))
    for (const tool of inspection) expect(endpoint.families.has(toolFamily(tool.name))).toBe(false);
  const chars = inspection.reduce(
    (total, tool) =>
      total +
      (Tool.getDescription(tool) ?? "").length +
      JSON.stringify(Tool.getJsonSchema(tool)).length,
    0,
  );
  // Measured at 5,011 characters for seven tools; external clients list them, threads never do.
  expect(chars).toBeLessThan(6_000);
});
