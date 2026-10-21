import * as Experiments from "../../experiments/ExperimentService.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as BuildWorkItems from "../../hq/BuildWorkItems.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ReleaseApprovals from "../../releases/ReleaseApprovals.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("thread-release-agent");
const codex = ProviderInstanceId.make("codex");
const candidate = "a".repeat(40);

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-release-agent"),
  requestNamespace: "provider-session-release-agent",
  thread: {
    threadId,
    providerSessionId: "provider-session-release-agent",
    providerInstanceId: codex,
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "release-approval-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "release-approval-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const input = {
  repository: "pechhe/yardsmith",
  candidate,
  base: "b".repeat(40),
  summary: {
    commits: 2,
    items: [],
    migrations: [],
    verification: { status: "passed" },
    coveredByEarlierApproval: false,
  },
  details: "Two commits.",
};

/** The caller's thread runs with `runStatus`, or has no run at all when it is null. */
const withTool = <A, E>(
  runStatus: "running" | "completed" | null,
  body: (
    cards: ReadonlyArray<OrchestrationV2ServerCommand>,
  ) => Effect.Effect<A, E, McpServer.McpServer>,
) => {
  const cards: Array<OrchestrationV2ServerCommand> = [];
  const shell = McpToolAccessTestkit.liveThreadShell(threadId);
  const projection = {
    thread: shell,
    runs:
      runStatus === null
        ? []
        : [
            {
              id: RunId.make("run-release-agent"),
              ordinal: 1,
              status: runStatus,
              providerInstanceId: codex,
              rootNodeId: NodeId.make("node-release-agent"),
            },
          ],
    messages: [],
    subagents: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const threadManagement = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadRecords: () => Effect.succeed(projection),
    getThreadShell: () => Effect.succeed(shell),
    dispatch: (command) =>
      Effect.sync(() => {
        cards.push(command);
        return {} as never;
      }),
    sendToThread: () => Effect.succeed({} as never),
  });
  return body(cards).pipe(
    Effect.provide(
      McpHttpServer.layerOrchestratorToolkit.pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(Layer.mock(BuildWorkItems.BuildWorkItems)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provide(NodeServices.layer),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.merge(
            NodeCrypto.layer,
            Layer.mock(Experiments.ExperimentService)({
              assignForTask: () => Effect.succeed([]),
              assignments: () => Effect.succeed([]),
            }),
          ),
        ),
        Layer.provide(threadManagement),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
        Layer.provide(
          ReleaseApprovals.layer.pipe(
            Layer.provide(
              Layer.mergeAll(threadManagement, NodeCrypto.layer, SqlitePersistence.layerMemory),
            ),
          ),
        ),
      ),
    ),
  );
};

const call = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "request_release_approval", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("request_release_approval opens a card for a thread with an active run", () =>
  withTool("running", (cards) =>
    Effect.gen(function* () {
      const result = yield* call(input);
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        status: "pending",
        candidate,
        joined: false,
        supersededCandidate: null,
        answer: null,
      });
      expect(cards).toMatchObject([
        { type: "release_approval.record", threadId, approvalStatus: "pending", candidate },
      ]);

      const again = yield* call({ ...input, repository: "pechhe/YardSmith" });
      expect(again.structuredContent).toMatchObject({
        requestId: (result.structuredContent as { requestId: string }).requestId,
        joined: true,
      });
    }),
  ),
);

it.effect("request_release_approval refuses input that is not a full commit id or repository", () =>
  withTool("running", (cards) =>
    Effect.gen(function* () {
      // Invalid arguments never reach the service: the protocol rejects the call itself.
      const short = yield* Effect.flip(call({ ...input, candidate: "abc123" }));
      expect(short).toMatchObject({ _tag: "InvalidParams" });
      expect(short.message).toContain("candidate must be a full lowercase commit id");
      const { repository: _repository, ...withoutRepository } = input;
      const missing = yield* Effect.flip(call(withoutRepository));
      expect(missing).toMatchObject({ _tag: "InvalidParams" });
      expect(cards).toEqual([]);
    }),
  ),
);

it.effect("request_release_approval refuses a thread with no active run", () =>
  withTool("completed", (cards) =>
    Effect.gen(function* () {
      const result = yield* call(input);
      expect(declaredFailure(result)).toMatchObject({ code: "parent_not_active" });
      expect(cards).toEqual([]);
    }),
  ),
);
