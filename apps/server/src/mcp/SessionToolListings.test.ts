import * as GitManager from "../git/GitManager.ts";
import * as FixtureRemoteDelegation from "../peer/RemoteDelegation.ts";
import * as AdviceMcpService from "./AdviceMcpService.ts";
import * as AssetSigner from "../assets/AssetSigner.ts";
import * as ContextPeerForwarding from "../peer/PeerForwarding.ts";
import * as ContextPeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as ContextPeerLinks from "../peer/PeerLinks.ts";
import * as ContextProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ContextDocumentText from "../provider/DocumentText.ts";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DecisionRouter from "../decisionRouting/DecisionRouter.ts";
import * as BrowserTaskService from "../browserTasks/BrowserTaskService.ts";
import { BOUNDED_BROWSER_TOOL_NAMES } from "./toolkits/browser/toolNames.ts";
import * as Champions from "../champions/ChampionService.ts";
import * as WebResearch from "./WebResearch.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  SESSION_TOOL_ENDPOINTS,
  isPullRequestTool,
  toolFamily,
  type SessionEndpointKey,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as BlackholeService from "../blackhole/BlackholeService.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import * as RunSetupStoreModule from "../agents/RunSetupStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ReleaseApprovals from "../releases/ReleaseApprovals.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ForgeReadService from "../weave/ForgeReadService.ts";
import * as WeaveAgentConnections from "../weave/WeaveAgentConnections.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderAdapterRegistryV2 from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadProjectMoveService from "../orchestration-v2/ThreadProjectMoveService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ExperimentService from "../experiments/ExperimentService.ts";
import * as ExperimentResults from "../experiments/ExperimentResults.ts";
import * as FleetSummaryService from "../fleet/FleetSummaryService.ts";
import * as UnattendedReactor from "../orchestration-v2/UnattendedReactor.ts";
import * as PeerEnvironments from "../peers/PeerEnvironments.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadDirectory from "../peers/ThreadDirectory.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestratorV2 from "../orchestration-v2/Orchestrator.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as ForgeWorkItems from "../weave/ForgeWorkItems.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as HiddenTools from "./HiddenTools.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as HandoffImport from "../peer/handoff/HandoffImport.ts";
import * as ThreadHandoff from "../peer/handoff/ThreadHandoff.ts";
import * as ThreadImportService from "../orchestration-v2/ThreadImportService.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as BrowserLogins from "../secrets/BrowserLogins.ts";

/**
 * Only the registry is built, so the tools never run and every service below is an
 * empty mock. This is the seam where a toolkit can be dropped from an endpoint
 * without any other test noticing.
 */
const weaveConnection = Layer.mock(WeaveAgentConnections.WeaveAgentConnections)({
  observe: (tool, args) =>
    Effect.sync(() => {
      const origin = "https://weave.example.test";
      if (tool === "weave_forge_query") {
        expect(args).toEqual({ action: "read", ref: "WV-143" });
        return { origin, connection: "test", value: { id: "spec", kind: "spec", bodyRevision: 3 } };
      }
      expect(tool).toBe("weave_docs_get_revision");
      expect(args).toEqual({ recordId: "spec", revision: 2 });
      return { origin, connection: "test", value: { content: "# Pinned Spec", revision: 2 } };
    }),
});

const serviceMocks = Layer.mergeAll(
  Layer.mock(AssetSigner.AssetSigner)({}),
  Layer.mock(DecisionRouter.DecisionRouter)({}),
  Layer.mock(BrowserTaskService.BrowserTaskService)({}),
  Layer.mock(BrowserLogins.BrowserLogins)({}),
  Layer.mock(Champions.ChampionService)({
    hasThreadContext: (threadId) => Effect.succeed(threadId === "champion"),
  }),
  Layer.mock(WebResearch.WebResearch)({}),
  Layer.mock(AdviceMcpService.AdviceMcpService)({}),
  Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
  Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
  Layer.mock(ThreadDirectory.ThreadDirectory)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(WorkspaceProvider.WorkspaceProvider)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(WorktreeMcpService.WorktreeMcpService)({}),
  Layer.mock(HtmlRender.HtmlRender)({}),
  Layer.mock(ForgeWorkItems.ForgeWorkItems)({}),
  Layer.mock(RunSetupStoreModule.RunSetupStore)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(ServerEnvironment.ServerEnvironment)({}),
  Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
  Layer.mock(GitManager.GitManager)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(HandoffImport.HandoffImport)({}),
  Layer.mock(ThreadHandoff.ThreadHandoff)({}),
  Layer.mock(ThreadImportService.ThreadImportService)({}),
  weaveConnection,
  ForgeReadService.layer.pipe(Layer.provide(weaveConnection)),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/tmp/projects" }),
  Layer.mock(ProviderAdapterRegistryV2.ProviderAdapterRegistryV2)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadProjectMoveService.ThreadProjectMoveService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(BlackholeService.BlackholeService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  // Never queried: the registry only describes tools.
  Layer.succeed(SqlClient.SqlClient, {} as never),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ExperimentService.ExperimentService)({}),
  Layer.mock(ExperimentResults.ExperimentResults)({}),
  Layer.mock(FleetSummaryService.FleetSummaryService)({}),
  Layer.mock(UnattendedReactor.UnattendedReactor)({}),
  Layer.mock(PeerEnvironments.PeerEnvironments)({}),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
  Layer.mock(OrchestratorV2.OrchestratorV2)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  McpToolAccessTestkit.liveThreadsLayer,
  ServerSettings.layerTest({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-session-tool-listings-test-" }),
);

/**
 * The registry only holds tool descriptors, so the tools never run: every service
 * below is an empty mock kept in step with the toolkits' handler dependencies.
 */
/** An owner policy that hides these tools, as the server reads it from the role policy. */
const hiddenToolPolicy = (hiddenTools: ReadonlyArray<string>) =>
  Layer.succeed(HiddenTools.HiddenTools, hiddenTools);
type HiddenToolPolicy = ReturnType<typeof hiddenToolPolicy>;

const listedTools = (
  key: SessionEndpointKey,
  hiddenTools: HiddenToolPolicy = hiddenToolPolicy([]),
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return server.tools.map(({ tool }) => tool);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerSessionToolkits(SESSION_TOOL_ENDPOINTS[key].families).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(serviceMocks),
        Layer.provide(hiddenTools),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Effect.scoped,
  );

/** The tool groups agent-config's role policy hides from a Pi run. */
const HIDDEN_TOOLS = ["*pull_request*", "t3_work_*", "t3_thread_launch"];

/** Whether `name` is one of the tools the three patterns cover. */
const coveredByHiddenTools = (name: string) =>
  /pull_request/u.test(name) || name.startsWith("t3_work_") || name === "t3_thread_launch";

const contextServices = Layer.mergeAll(
  ContextDocumentText.layer.pipe(Layer.provide(NodeServices.layer)),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(ContextPeerForwarding.PeerForwarding)({}),
      Layer.mock(ContextPeerLinkRequests.PeerLinkRequests)({}),
      Layer.mock(ContextPeerLinks.PeerLinks)({}),
      Layer.mock(ContextProjectCloneTracker.ProjectCloneTracker)({}),
    ),
  ),
);

const listedToolNames = (
  key: SessionEndpointKey,
  hiddenTools: HiddenToolPolicy = hiddenToolPolicy([]),
) =>
  listedTools(key, hiddenTools).pipe(
    Effect.map((tools) => tools.map((tool) => tool.name).toSorted()),
  );

it.effect("lists one browser family on every endpoint that browses, and none of the old ones", () =>
  Effect.gen(function* () {
    for (const key of Object.keys(SESSION_TOOL_ENDPOINTS) as Array<SessionEndpointKey>) {
      const tools = yield* listedTools(key);
      const names = tools.map((tool) => tool.name);
      expect(
        names.filter((name) => /^(preview_|t3_preview_|t3_browser_)/u.test(name)),
        key,
      ).toEqual([]);
      const open = tools.find((candidate) => candidate.name === "browser_open");
      expect(open !== undefined, key).toBe(key !== "research");
      if (open === undefined) continue;
      expect(open.description).toContain(McpToolAccessTestkit.HEADLESS_OPEN);
      expect(open.description).toContain(McpToolAccessTestkit.SETTING_OPEN);
    }
  }).pipe(
    Effect.provide(
      Layer.merge(contextServices, Layer.mock(FixtureRemoteDelegation.RemoteDelegation)({})),
    ),
  ),
);

it.effect("registers only the tool families each session endpoint declares", () =>
  Effect.gen(function* () {
    for (const key of Object.keys(SESSION_TOOL_ENDPOINTS) as Array<SessionEndpointKey>) {
      const names = yield* listedToolNames(key);
      const { families } = SESSION_TOOL_ENDPOINTS[key];
      expect(
        names.filter((name) => !families.has(toolFamily(name))),
        key,
      ).toEqual([]);
      expect(names.includes("t3_forge_read"), key).toBe(key === "editor" || key === "reader");
      expect(names.includes("web_search"), key).toBe(key === "editor" || key === "research");
      expect(
        names.filter((name) =>
          /^(t3_experiments_|t3_work_|agent_session_attach$|agent_task_outcome$)/u.test(name),
        ),
        key,
      ).toEqual([]);
      // Registered wherever the browser is; only a credential granted bounded tasks lists it.
      expect(names.includes("browser_task"), key).toBe(key !== "research");
    }
  }).pipe(
    Effect.provide(
      Layer.merge(contextServices, Layer.mock(FixtureRemoteDelegation.RemoteDelegation)({})),
    ),
  ),
);

it.effect("gives an editor every toolkit, including what used to be workspace-only", () =>
  Effect.gen(function* () {
    const names = yield* listedToolNames("editor");

    expect(names).toEqual(
      expect.arrayContaining([
        "t3_worktree_handoff",
        "t3_thread_update",
        "t3_thread_launch",
        "link_pull_requests",
        "list_thread_pull_requests",
        "t3_terminal_read",
        "t3_attachment_prepare_upload",
        "browser_handoff",
        "device_open",
        ...BOUNDED_BROWSER_TOOL_NAMES,
      ]),
    );
    // One tool each for launching, changing a thread and linking pull requests.
    for (const retired of [
      "create_threads",
      "t3_thread_move_to_project",
      "t3_thread_organize",
      "link_pull_request",
      "unlink_pull_request",
    ])
      expect(names).not.toContain(retired);
    expect(names.filter((name) => name === "t3_thread_update")).toHaveLength(1);
  }).pipe(
    Effect.provide(
      Layer.merge(contextServices, Layer.mock(FixtureRemoteDelegation.RemoteDelegation)({})),
    ),
  ),
);

it.effect("hides the tools an owner's policy lists, and restores them when it lists none", () =>
  Effect.gen(function* () {
    const covered = (names: ReadonlyArray<string>) => names.filter(coveredByHiddenTools);
    expect(covered(yield* listedToolNames("editor"))).not.toEqual([]);
    expect(covered(yield* listedToolNames("editor", hiddenToolPolicy([])))).not.toEqual([]);
    const hidden = yield* listedToolNames("editor", hiddenToolPolicy(HIDDEN_TOOLS));
    expect(covered(hidden)).toEqual([]);
    // Only what the patterns name: the rest of the catalogue is untouched.
    expect(hidden).toEqual(
      expect.arrayContaining(["t3_thread_list", "t3_worktree_handoff", "delegate_task"]),
    );
    expect(hidden).toEqual(
      (yield* listedToolNames("editor", hiddenToolPolicy([]))).filter(
        (name) => !coveredByHiddenTools(name),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.merge(contextServices, Layer.mock(FixtureRemoteDelegation.RemoteDelegation)({})),
    ),
  ),
);

it.effect("loads editor tools through its own deferred HTTP catalogue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId: EnvironmentId.make("editor-tools-test"),
        requestNamespace: "editor-tools-test",
        endpointKey: "editor",
        providerDriver: ProviderDriverKind.make("pi"),
        webResearchTools: true,
        thread: {
          threadId: ThreadId.make("editor-tools-test"),
          providerSessionId: "editor-tools-test",
          providerInstanceId: ProviderInstanceId.make("antigravity"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const keys = ["editor", "reader", "research", "preview"] as const;
      const endpoint = (key: SessionEndpointKey) =>
        McpHttpServer.layerSessionTransport(
          key,
          McpHttpServer.layerSessionToolkits(SESSION_TOOL_ENDPOINTS[key].families),
        );
      const endpoints = Layer.mergeAll(
        endpoint("editor"),
        endpoint("reader"),
        endpoint("research"),
        endpoint("preview"),
      ).pipe(
        Layer.provide(serviceMocks),
        Layer.provide(contextServices),
        Layer.provide(Layer.mock(FixtureRemoteDelegation.RemoteDelegation)({})),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) =>
              Effect.succeed({
                ...scope,
                ...(token === "champion"
                  ? { thread: { ...scope.thread, threadId: ThreadId.make("champion") } }
                  : {}),
                slipJay: token.endsWith("-slipjay"),
                ...(token === "claude"
                  ? {
                      providerDriver: ProviderDriverKind.make("claudeAgent"),
                      capabilities: new Set(["device" as const]),
                    }
                  : {}),
                endpointKey: keys.find((key) => token.startsWith(key)) ?? "editor",
              }),
          }),
        ),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      yield* HttpRouter.serve(endpoints, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const client = yield* HttpClient.HttpClient;
      const connect = (key: SessionEndpointKey, token: string = key, deferred = true) =>
        Effect.gen(function* () {
          const path = SESSION_TOOL_ENDPOINTS[key].path;
          const headers = {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            ...(deferred ? { "t3-tool-exposure": "deferred" } : {}),
          };
          const initialize = yield* client.post(path, {
            headers,
            body: HttpBody.jsonUnsafe({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "probe", version: "1" },
              },
            }),
          });
          const rpc = (method: string, params: object) =>
            client
              .post(path, {
                headers: {
                  ...headers,
                  "mcp-session-id": initialize.headers["mcp-session-id"]!,
                  "mcp-protocol-version": "2025-06-18",
                },
                body: HttpBody.jsonUnsafe({ jsonrpc: "2.0", id: 2, method, params }),
              })
              .pipe(
                Effect.flatMap((response) => response.text),
                Effect.map((text) =>
                  text
                    .split("\n")
                    .filter((line) => line.startsWith("data: ") || line.startsWith("{"))
                    .map(
                      (line) =>
                        JSON.parse(line.replace(/^data: /u, "")) as {
                          id?: number;
                          error?: { code: number; message: string };
                          result?: { tools?: Array<{ name: string }>; structuredContent?: unknown };
                        },
                    )
                    .find((message) => message.id === 2)!,
                ),
              );
          return {
            rpc,
            listed: rpc("tools/list", {}).pipe(
              Effect.map((body) => body.result!.tools!.map((tool) => tool.name).sort()),
            ),
          };
        });
      const ordinary = yield* (yield* connect("editor", "editor", false)).listed;
      const champion = yield* (yield* connect("editor", "champion", false)).listed;
      const ordinaryReader = yield* (yield* connect("reader", "reader", false)).listed;
      for (const names of [ordinary, ordinaryReader]) {
        expect(names).toContain("t3_forge_read");
        expect(names).toContain("t3_champions_learning_search");
        expect(names).toContain("t3_champions_learning_read");
        expect(names).not.toContain("t3_background_wait");
        expect(names.filter((name) => name.startsWith("device_"))).toEqual([]);
        expect(
          names.filter((name) => /^t3_champions_(?!learning_(search|read)$)/u.test(name)),
        ).toEqual([]);
      }
      for (const key of ["editor", "reader"] as const) {
        const git = yield* (yield* connect(key, key, false)).listed;
        const slipJay = yield* (yield* connect(key, key + "-slipjay", false)).listed;
        expect(git).toContain("list_thread_pull_requests");
        expect(slipJay.filter(isPullRequestTool)).toEqual([]);
      }
      expect(ordinary).toContain("pull_request_read");
      expect(ordinary).toContain("ci_logs");
      const claude = yield* (yield* connect("editor", "claude", false)).listed;
      expect(claude).toEqual(
        expect.arrayContaining(["t3_background_wait", "device_list", "device_screenshot"]),
      );
      expect(ordinary).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
      expect(champion).toContain("t3_champions_report");
      const editor = yield* connect("editor");
      const reader = yield* connect("reader");
      const core = [
        "call_mcp_tool",
        "delegate_task",
        "orchestrator_capabilities",
        "task_status",
        "tool_search",
      ];
      expect(yield* editor.listed).toEqual(core);
      expect(yield* reader.listed).toEqual(core);
      const result = yield* editor.rpc("tools/call", {
        name: "tool_search",
        arguments: { query: "html_render" },
      });
      expect(result.result?.structuredContent).toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ name: "html_render" })]),
      });
      expect(yield* editor.listed).toContain("html_render");
      expect(yield* reader.listed).toEqual(core);
      for (const session of [editor, reader]) {
        const found = yield* session.rpc("tools/call", {
          name: "tool_search",
          arguments: { query: "forge spec acceptance" },
        });
        expect(found.result?.structuredContent).toMatchObject({
          tools: expect.arrayContaining([expect.objectContaining({ name: "t3_forge_read" })]),
        });
      }
      for (const key of ["research", "preview"] as const) {
        const session = yield* connect(key);
        const found = yield* session.rpc("tools/call", {
          name: "tool_search",
          arguments: { query: "t3_forge_read" },
        });
        expect(found.result?.structuredContent).toMatchObject({ tools: [] });
        expect(yield* session.listed).not.toContain("t3_forge_read");
        const denied = yield* session.rpc("tools/call", {
          name: "t3_forge_read",
          arguments: { ref: "WV-143" },
        });
        expect(denied.error?.message).toContain("not found");
      }
      const forgeRead = yield* reader.rpc("tools/call", {
        name: "t3_forge_read",
        arguments: { ref: " WV-143 ", bodyRevision: 2, includeContext: false },
      });
      expect(forgeRead.result?.structuredContent).toMatchObject({
        origin: "https://weave.example.test",
        item: { id: "spec", kind: "spec" },
        body: "# Pinned Spec",
        bodyRevision: 2,
        currentBodyRevision: 3,
      });
      yield* reader.rpc("tools/call", { name: "tool_search", arguments: { query: "html_render" } });
      expect(yield* reader.listed).toContain("html_render");
      yield* reader.rpc("tools/call", {
        name: "tool_search",
        arguments: { query: "t3_project_create" },
      });
      expect(yield* reader.listed).not.toContain("t3_project_create");
      const denied = yield* reader.rpc("tools/call", { name: "t3_project_create", arguments: {} });
      expect(denied.error?.message).toContain("not found");
      const forwardedDenied = yield* reader.rpc("tools/call", {
        name: "call_mcp_tool",
        arguments: { name: "t3_project_create", arguments: {} },
      });
      expect(forwardedDenied.error?.message).toContain("not found");
      const recursive = yield* editor.rpc("tools/call", {
        name: "call_mcp_tool",
        arguments: { name: "call_mcp_tool", arguments: {} },
      });
      expect(recursive.error?.message).toContain("recursive");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses a hidden tool to a script that knows its name", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId: EnvironmentId.make("hidden-tools-test"),
        requestNamespace: "hidden-tools-test",
        endpointKey: "editor",
        thread: {
          threadId: ThreadId.make("hidden-tools-test"),
          providerSessionId: "hidden-tools-test",
          providerInstanceId: ProviderInstanceId.make("pi"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const endpoints = McpHttpServer.layerSessionTransport(
        "editor",
        McpHttpServer.layerSessionToolkits(SESSION_TOOL_ENDPOINTS.editor.families),
      ).pipe(
        Layer.provide(serviceMocks),
        Layer.provide(contextServices),
        Layer.provide(Layer.mock(FixtureRemoteDelegation.RemoteDelegation)({})),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: () => Effect.succeed(scope),
          }),
        ),
        Layer.provide(hiddenToolPolicy(HIDDEN_TOOLS)),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      yield* HttpRouter.serve(endpoints, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const client = yield* HttpClient.HttpClient;
      const path = SESSION_TOOL_ENDPOINTS.editor.path;
      const headers = {
        accept: "application/json, text/event-stream",
        authorization: "Bearer hidden-tools",
        "t3-tool-exposure": "deferred",
      };
      const initialize = yield* client.post(path, {
        headers,
        body: HttpBody.jsonUnsafe({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "probe", version: "1" },
          },
        }),
      });
      const rpc = (method: string, params: object) =>
        client
          .post(path, {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.jsonUnsafe({ jsonrpc: "2.0", id: 2, method, params }),
          })
          .pipe(
            Effect.flatMap((response) => response.text),
            Effect.map((text) =>
              text
                .split("\n")
                .filter((line) => line.startsWith("data: ") || line.startsWith("{"))
                .map(
                  (line) =>
                    JSON.parse(line.replace(/^data: /u, "")) as {
                      id?: number;
                      error?: { code: number; message: string };
                      result?: {
                        tools?: ReadonlyArray<{ name: string }>;
                        structuredContent?: unknown;
                      };
                    },
                )
                .find((message) => message.id === 2)!,
            ),
          );
      const listed = yield* rpc("tools/list", {});
      expect(listed.result!.tools!.map((tool) => tool.name).sort()).toEqual([
        "call_mcp_tool",
        "delegate_task",
        "orchestrator_capabilities",
        "task_status",
        "tool_search",
      ]);
      // Search never finds them, however the query names them.
      const found = (result: { tools?: ReadonlyArray<{ name: string }> } | undefined) =>
        (result?.tools ?? []).map((tool) => tool.name);
      const searched = yield* rpc("tools/call", {
        name: "tool_search",
        arguments: { query: "pull request link" },
      });
      const searchedNames = found(searched.result!.structuredContent as never);
      expect(searchedNames.length).toBeGreaterThan(0);
      expect(searchedNames.filter(coveredByHiddenTools)).toEqual([]);
      const byName = yield* rpc("tools/call", {
        name: "tool_search",
        arguments: { query: "t3_work_enroll" },
      });
      expect(found(byName.result!.structuredContent as never)).not.toContain("t3_work_enroll");
      // Nor can a script that already knows the name call one.
      const called = yield* rpc("tools/call", { name: "link_pull_requests", arguments: {} });
      expect(called.error!.message).toContain("not found");
      const scripted = yield* rpc("tools/call", {
        name: "call_mcp_tool",
        arguments: { name: "link_pull_requests", arguments: {} },
      });
      expect(scripted.error!.message).toContain("not found");
      const started = yield* rpc("tools/call", { name: "t3_thread_launch", arguments: {} });
      expect(started.error!.message).toContain("not found");
      // A tool the policy leaves alone still answers.
      const kept = yield* rpc("tools/call", {
        name: "tool_search",
        arguments: { query: "t3_thread_list" },
      });
      expect(kept.result!.structuredContent).toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ name: "t3_thread_list" })]),
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
