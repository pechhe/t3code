import * as EnvironmentAdvice from "../../agents/AdviceService.ts";

import * as Experiments from "../../experiments/ExperimentService.ts";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";
import * as ForgeWorkItems from "../../weave/ForgeWorkItems.ts";

import { McpSchema, McpServer } from "effect/ai";

import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";

import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ReleaseApprovals from "../../releases/ReleaseApprovals.ts";
import * as RemoteDelegation from "../../peer/RemoteDelegation.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";

import * as ServerSettings from "../../serverSettings.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";

import * as PeerForwarding from "../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as ThreadHandoff from "../../peer/handoff/ThreadHandoff.ts";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(EnvironmentAdvice.layer),
  Layer.provide(Layer.mock(ThreadHandoff.ThreadHandoff)({})),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(ForgeWorkItems.ForgeWorkItems)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provide(SqlitePersistence.layerMemory),
);

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-core", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-core", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const clientScope = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access },
  issuedAt: 0,
  capabilities: new Set(["orchestration", "worktree", "pull-requests", "issues"]),
});

it.effect(
  "routes a client caller's delegation to external work, unavailable when unconfigured",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "delegate_task",
          arguments: { task: "Review", mode: "async" },
        })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            clientScope("full-access"),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(declaredFailure(result)).toMatchObject({ code: "capability_denied" });
    }).pipe(
      Effect.provide(
        layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provide(
            Layer.merge(
              NodeCrypto.layer,
              Layer.mock(Experiments.ExperimentService)({
                assignForTask: () => Effect.succeed([]),
                assignments: () => Effect.succeed([]),
              }),
            ),
          ),
          Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
          Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
          Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
          Layer.provide(Layer.mock(ReleaseApprovals.ReleaseApprovals)({})),
          Layer.provideMerge(Layer.mergeAll(Layer.mock(RemoteDelegation.RemoteDelegation)({}))),
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.mock(PeerForwarding.PeerForwarding)({}),
              Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
              Layer.mock(PeerLinks.PeerLinks)({ get: () => Effect.succeedNone }),
            ),
          ),
        ),
      ),
    ),
);
