import { CallMcpTool, ToolSearchToolkit } from "./toolkits/toolSearch/tools.ts";
import { DecisionToolkit } from "./toolkits/decisions/tools.ts";
import {
  isToolListedForSession,
  READ_ONLY_TOOLS,
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
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { codexTurnInstructionListing } from "../orchestration-v2/Adapters/CodexToolListing.ts";
import type * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { buildCodexAdditionalContext } from "../provider/CodexDeveloperInstructions.ts";
import {
  NO_PROJECT_NOTE,
  unreplacedWorkspaceNote,
} from "../orchestration-v2/ProviderTurnStartService.ts";
import { buildPiRpcLaunch } from "../../../../packages/provider-pi/src/server/mcpInjection.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { BrowserSnapshotToolkit, BrowserToolkit } from "./toolkits/browser/tools.ts";
import { ThreadUpdateToolkit } from "./toolkits/threadUpdate/tools.ts";
import { DeviceToolkit } from "./toolkits/device/tools.ts";
import { ExperimentsToolkit } from "./toolkits/experiments/tools.ts";
import { HtmlPreviewToolkit, HtmlRenderToolkit } from "./toolkits/html/tools.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { FleetToolkit } from "./toolkits/fleet/tools.ts";
import { TerminalToolkit } from "./toolkits/terminal/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { WorkspaceToolkit } from "./toolkits/workspace/tools.ts";
import { WebToolkit } from "./toolkits/web/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import { MANAGED_BROWSER_TOOL_NAMES } from "./toolkits/browser/toolNames.ts";
import { ChampionsToolkit } from "./toolkits/champions/tools.ts";

const tools = [
  ...Object.values(DecisionToolkit.tools),
  // Sessions list the consolidated t3_thread_update in place of upstream's.
  ...Object.values(OrchestratorToolkit.tools).filter((tool) => tool.name !== "t3_thread_update"),
  ...Object.values(ThreadUpdateToolkit.tools),
  ...Object.values(BrowserToolkit.tools),
  ...Object.values(BrowserSnapshotToolkit.tools),
  ...Object.values(DeviceToolkit.tools),
  ...Object.values(ExperimentsToolkit.tools),
  ...Object.values(HtmlPreviewToolkit.tools),
  ...Object.values(HtmlRenderToolkit.tools),
  ...Object.values(AttachmentToolkit.tools),
  ...Object.values(EnvironmentToolkit.tools),
  ...Object.values(FleetToolkit.tools),
  ...Object.values(TerminalToolkit.tools),
  ...Object.values(ProjectToolkit.tools),
  ...Object.values(PullRequestsToolkit.tools),
  ...Object.values(ThreadToolkit.tools),
  ...Object.values(WebToolkit.tools),
  ...Object.values(WorktreeToolkit.tools),
  ...Object.values(ChampionsToolkit.tools),
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
) =>
  ({
    toolProfile,
    agentRole,
    readOnly: toolProfile !== "implementation" && toolProfile !== undefined,
  }) satisfies SessionToolProfile;

// These ceilings catch tools growing unnoticed. An editor lists every tool; providers load them lazily.
// Raise one only in the change that grows it, and say why in that change.
const budgets: ReadonlyArray<[string, SessionToolProfile | undefined, number]> = [
  // T3-814: 152_300 for t3_champions_models (replacing the class-choices tool) and how to clear an override.
  // 159_000: upstream v0.1.11-nightly.20261120.4979 grew the editor listing to 158_736.
  ["editor", undefined, 159_000],
  ["editor worker", session("implementation", "implementer"), 159_000],
  // T3-853: the browser family is counted now (browser_task's schema alone is ~29K); the bounded
  // tools it replaced were listed to readers and browser tasks but missing from this catalogue.
  ["reader", session("source-reader", "reviewer"), 82_000],
  ["browser", session("phi", "browser"), 58_500],
  ["scout", session("web-research", "scout"), 19_500],
];

it("keeps every session endpoint under its payload budget", () => {
  for (const [label, profile, ceiling] of budgets) {
    expect.soft(payloadChars(profile), `${label} payload chars`).toBeLessThan(ceiling);
  }
});

it("lists a browser session only the families it uses", () => {
  // The browser is what the session is for; leaf gives it its own task status, cancel,
  // watch and the html tools to show the user a page. A later
  // family added here fails this test rather than quietly raising the budget.
  expect([...SESSION_TOOL_ENDPOINTS.preview.families].sort()).toEqual([
    "browser",
    "decision",
    "device",
    "leaf",
    "learnings",
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
  ["delegated browser", session("phi", "browser")],
  ["delegated implementation-worker", session("implementation", "implementer")],
  ["delegated scout", session("web-research", "scout")],
  ["delegated advisor", session("source-reader", "advisor")],
  ["delegated reviewer", session("source-reader", "reviewer")],
];

const textFor = (profile: SessionToolProfile | undefined) => {
  const families = sessionToolFamilies(profile);
  return t3OrchestrationText(profile !== undefined, {
    preview: sessionEndpointKey(profile) === "preview",
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

  // The child text covers both classes, so it names no tool only one of them lists.
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
    expect(childNamed.has(name), `child text does not name ${name}, which its class may lack`).toBe(
      false,
    );
  }
  expect(childNamed.has("html_render")).toBe(true);
});

it("tells a managed browser task about preview and devices, and that listing is only those", () => {
  // A managed browser task's endpoint serves Phi's operations and the device tools and nothing
  // else, so its child text must not name html or worktree.
  const narrow = t3OrchestrationText(true, { preview: true, hasDeviceTools: true, html: false });
  const narrowNamed = new Set(toolsNamedIn(narrow));
  expect(narrowNamed.has("browser_open")).toBe(true);
  expect(narrowNamed.has("device_open")).toBe(true);
  expect(narrowNamed.has("html_render")).toBe(false);
  expect(narrowNamed.has("t3_worktree_handoff")).toBe(false);

  for (const name of MANAGED_BROWSER_TOOL_NAMES) {
    expect(toolFamily(name), `${name} has its explicit tool family`).toBe(
      name === "t3_decide" ? "decision" : name.startsWith("device_") ? "device" : "browser",
    );
  }
});

it("lists every editor the same tools, whatever its role", () => {
  const ordinary = names(undefined);
  for (const role of ["implementer", "lead"] as const)
    expect(names(session("implementation", role))).toEqual(ordinary);
  for (const name of [
    "delegate_task",
    "t3_thread_launch",
    "schedule_task",
    "t3_champions_control",
    "t3_champions_record_learning",
    "t3_terminal_read",
    "link_pull_requests",
    "t3_thread_update",
    "browser_open",
    "browser_handoff",
    "device_open",
    "web_search",
  ])
    expect(ordinary.has(name), name).toBe(true);
  expect(ordinary.has("workspace_read_file")).toBe(false);
  expect(ordinary.has("t3_thread_import")).toBe(false);
});

it("keeps a read-only agent to the closed list, and every name on it real", () => {
  const catalogue = [...tools, ...Object.values(ToolSearchToolkit.tools), CallMcpTool].map(
    (tool) => tool.name,
  );
  const reader = session("source-reader", "reviewer");
  const known = new Set<string>(catalogue);
  for (const name of READ_ONLY_TOOLS) {
    expect(known.has(name), `${name} exists`).toBe(true);
    expect(
      SESSION_TOOL_ENDPOINTS.reader.families.has(toolFamily(name)),
      `${name}'s family is served`,
    ).toBe(true);
  }
  for (const name of catalogue)
    expect(isToolListedForSession(name, reader), name).toBe(READ_ONLY_TOOLS.has(name));
  for (const refused of [
    "t3_thread_send",
    "t3_thread_launch",
    "create_threads",
    "schedule_task",
    "run_scheduled_task_now",
    "t3_champions_control",
    "t3_pending_request",
    "t3_thread_configure",
    "t3_project_delete",
    "t3_thread_interrupt",
    "t3_queue_add",
  ])
    expect(isToolListedForSession(refused, reader), refused).toBe(false);
  // The class comes from the task's recorded access, so a narrowed writer lists the same.
  expect(names({ toolProfile: "source-reader", agentRole: "implementer", readOnly: true })).toEqual(
    names(reader),
  );
});

it("keeps browser agents and web-reading scouts off threads and delegation", () => {
  for (const narrow of [
    names(session("phi", "browser")),
    names(session("phi", "ui-verifier")),
    names(session("web-research", "scout")),
  ]) {
    for (const name of [
      "t3_thread_read",
      "delegate_task",
      "schedule_task",
      "t3_thread_launch",
      "t3_champions_get",
    ])
      expect(narrow.has(name), name).toBe(false);
    expect(narrow.has("t3_champions_learning_search")).toBe(true);
    expect(narrow.has("agent_task_outcome")).toBe(false);
  }
  expect(names(session("phi", "browser")).has("browser_act")).toBe(true);
  expect(names(session("phi", "browser")).has("device_open")).toBe(true);
  expect(names(session("web-research", "scout")).has("web_search")).toBe(true);
});

it("hands all three harnesses the same session endpoint", () => {
  for (const profile of [
    undefined,
    session("phi", "browser"),
    session("implementation", "implementer"),
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
  expect(reader).not.toContain("browser_open");
  expect(reader).not.toContain("device_open");
  expect(reader).toContain("html_render");
  const browser = text({ delegated: true, listsPreview: true, listsHtml: true });
  expect(browser).toContain("browser_open");
  expect(browser).not.toContain("device_open");

  // The narrow managed-browser credential: preview only, no html.
  const narrow = text({ delegated: true, listsPreview: true, listsHtml: false });
  expect(narrow).toContain("browser_open");
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
  expect(reader.env.T3_PI_INSTRUCTIONS).not.toContain("browser_open");

  // The narrow browser credential: preview without html.
  const narrow = launch({ delegated: true, listsPreview: true, listsHtml: false });
  expect(narrow.env.T3_PI_INSTRUCTIONS).toContain("browser_open");
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

it("keeps the peer-only thread import off every session endpoint", () => {
  expect(toolFamily("t3_thread_import")).toBe("peer");
  for (const endpoint of Object.values(SESSION_TOOL_ENDPOINTS))
    expect(endpoint.families.has("peer")).toBe(false);
});

it("lists t3_background_wait to editors and read-only agents, which is where its Claude instruction goes", () => {
  expect(isToolListedForSession("t3_background_wait", undefined)).toBe(true);
  expect(isToolListedForSession("t3_background_wait", session("source-reader", "scout"))).toBe(
    true,
  );
  expect(isToolListedForSession("t3_background_wait", session("phi", "browser"))).toBe(false);
});
