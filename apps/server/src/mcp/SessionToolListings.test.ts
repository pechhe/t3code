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
import * as HqAgentConnections from "../hq/HqAgentConnections.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderAdapterRegistryV2 from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadProjectMoveService from "../orchestration-v2/ThreadProjectMoveService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ExperimentService from "../experiments/ExperimentService.ts";
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
import * as ForgeWorkItems from "../hq/ForgeWorkItems.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

/**
 * Only the registry is built, so the tools never run and every service below is an
 * empty mock. This is the seam where a toolkit can be dropped from an endpoint
 * without any other test noticing.
 */
const serviceMocks = Layer.mergeAll(
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
  Layer.mock(HqAgentConnections.HqAgentConnections)({}),
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
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(serviceMocks),
        Layer.provide(NodeServices.layer),
      ),
    ),
    Effect.scoped,
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
      if (key === "child-research" || key === "research") {
        expect(names).toContain("t3_experiments_list");
        expect(names.includes("t3_work_enroll")).toBe(key === "research");
      }
    }
  }),
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
  }),
);
