import * as AssetSigner from "../assets/AssetSigner.ts";
import * as ContextPeerForwarding from "../peer/PeerForwarding.ts";
import * as ContextPeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as ContextPeerLinks from "../peer/PeerLinks.ts";
import * as ContextProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ContextDocumentText from "../provider/DocumentText.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DecisionRouter from "../decisionRouting/DecisionRouter.ts";
import * as BrowserTaskService from "../browserTasks/BrowserTaskService.ts";
import { BOUNDED_BROWSER_TOOL_NAMES } from "./toolkits/boundedBrowser/toolNames.ts";
import * as Champions from "../champions/ChampionService.ts";
import * as WebResearch from "./WebResearch.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SESSION_TOOL_ENDPOINTS, toolFamily, type SessionEndpointKey } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import * as RunSetupRecorder from "../agents/RunSetupRecorder.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ReleaseApprovals from "../releases/ReleaseApprovals.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
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
const serviceMocks = Layer.mergeAll(
  Layer.mock(AssetSigner.AssetSigner)({}),
  Layer.mock(DecisionRouter.DecisionRouter)({}),
  Layer.mock(BrowserTaskService.BrowserTaskService)({}),
  Layer.mock(BrowserLogins.BrowserLogins)({}),
  Layer.mock(Champions.ChampionService)({}),
  Layer.mock(WebResearch.WebResearch)({}),
  Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
  Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
  Layer.mock(ThreadDirectory.ThreadDirectory)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(WorkspaceProvider.WorkspaceProvider)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(WorktreeMcpService.WorktreeMcpService)({}),
  Layer.mock(HtmlRender.HtmlRender)({}),
  Layer.mock(ForgeWorkItems.ForgeWorkItems)({}),
  Layer.mock(RunSetupRecorder.RunSetupStore)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(ServerEnvironment.ServerEnvironment)({}),
  Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(HandoffImport.HandoffImport)({}),
  Layer.mock(ThreadHandoff.ThreadHandoff)({}),
  Layer.mock(ThreadImportService.ThreadImportService)({}),
  Layer.mock(WeaveAgentConnections.WeaveAgentConnections)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/tmp/projects" }),
  Layer.mock(ProviderAdapterRegistryV2.ProviderAdapterRegistryV2)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadProjectMoveService.ThreadProjectMoveService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
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
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  McpToolAccessTestkit.liveThreadsLayer,
  ServerSettings.layerTest({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-session-tool-listings-test-" }),
);

/**
 * The registry only holds tool descriptors, so the tools never run: every service
 * below is an empty mock kept in step with the toolkits' handler dependencies.
 */
const listedToolNames = (key: SessionEndpointKey) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return server.tools.map(({ tool }) => tool.name).toSorted();
  }).pipe(
    Effect.provide(
      McpHttpServer.layerSessionToolkits(SESSION_TOOL_ENDPOINTS[key].families).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(serviceMocks),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Effect.scoped,
  );

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

it.effect("registers only the tool families each session endpoint declares", () =>
  Effect.gen(function* () {
    for (const key of Object.keys(SESSION_TOOL_ENDPOINTS) as Array<SessionEndpointKey>) {
      const names = yield* listedToolNames(key);
      const { families } = SESSION_TOOL_ENDPOINTS[key];
      expect(
        names.filter((name) => !families.has(toolFamily(name))),
        key,
      ).toEqual([]);
      expect(names.includes("web_search"), key).toBe(
        key === "research" || key === "child-research",
      );
      expect(names.includes("web_fetch"), key).toBe(key === "research" || key === "child-research");
      expect(names.includes("t3_experiments_create"), key).toBe(
        key === "control" || key === "workspace" || key === "research",
      );
      expect(names.includes("t3_experiments_record_outcome"), key).toBe(key === "research");
      expect(names.includes("t3_work_enroll"), key).toBe(key === "research");
      expect(names.includes("t3_browser_task"), key).toBe(
        key === "control" || key === "workspace" || key === "bounded-browser",
      );
    }
  }).pipe(Effect.provide(contextServices)),
);

it.effect("serves a bounded browser leaf exactly the bounded tools", () =>
  Effect.gen(function* () {
    expect(yield* listedToolNames("bounded-browser")).toEqual(
      [...BOUNDED_BROWSER_TOOL_NAMES].toSorted(),
    );
  }).pipe(Effect.provide(contextServices)),
);

it.effect("gives an ordinary thread the handoff its instructions name", () =>
  Effect.gen(function* () {
    const names = yield* listedToolNames("control");

    expect(names).toEqual(
      expect.arrayContaining([
        "t3_worktree_handoff",
        "t3_worktree_attach",
        "t3_worktree_detach",
        "t3_worktree_list",
        "t3_worktree_status",
        "create_threads",
        "t3_project_list",
        "t3_thread_move_to_project",
        "t3_thread_suggest_project",
      ]),
    );
    // The rest of the workspace profile stays off the ordinary endpoint.
    expect(names).not.toEqual(
      expect.arrayContaining([
        "link_pull_request",
        "t3_terminal_read",
        "t3_attachment_read",
        "preview_open",
      ]),
    );
  }).pipe(Effect.provide(contextServices)),
);
