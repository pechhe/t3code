import * as Experiments from "../../../experiments/ExperimentService.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import * as RunSetupRecorder from "../../../agents/RunSetupRecorder.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadProjectMove from "../../../orchestration-v2/ThreadProjectMoveService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

type ThreadProjectMoveInput = Parameters<
  ThreadProjectMove.ThreadProjectMoveService["Service"]["move"]
>[0];

const threadId = ThreadId.make("project-move-thread");
const scratchProjectId = ProjectId.make("project:scratch");
const targetProjectId = ProjectId.make("project:yardsmith");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("project-move-environment"),
  requestNamespace: "project-move-session",
  thread: {
    threadId,
    providerSessionId: "project-move-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "project-move", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "project-move", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

/** The thread toolkit for one caller thread in `projectId`, recording dispatched commands. */
const layerFor = (
  projectId: ProjectId,
  dispatched: Array<OrchestrationV2ServerCommand>,
  moves: Array<ThreadProjectMoveInput> = [],
) =>
  McpHttpServer.layerThreadToolkit.pipe(
    Layer.provide(
      Layer.mock(ThreadProjectMove.ThreadProjectMoveService)({
        move: (input) =>
          input.projectId === targetProjectId
            ? Effect.sync(() => {
                moves.push(input);
                return { sequence: 7 } as never;
              })
            : Effect.fail(
                new ThreadProjectMove.ThreadProjectMoveError({
                  message: "The project was not found.",
                }),
              ),
      }),
    ),
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(Layer.mock(RunSetupRecorder.RunSetupStore)({})),
    Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getByWorkspaceRoot: (root) =>
          Effect.succeed(
            root === "/scratch" ? Option.some({ id: scratchProjectId } as never) : Option.none(),
          ),
        getById: (id) =>
          Effect.succeed(
            id === targetProjectId ? Option.some({ id: targetProjectId } as never) : Option.none(),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        scratchRoot: Effect.succeed(Option.some("/scratch")),
        namedProjectsRoot: "/unused",
      }),
    ),
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
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
        getProjectThreadRecords: () =>
          Effect.succeed({
            thread: {
              id: threadId,
              projectId,
              title: "Chaser email",
              runtimeMode: "full-access",
              interactionMode: "default",
              projectSuggestion: null,
              deletedAt: null,
            },
          } as never),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length } as never;
          }),
      }),
    ),
  );

const call = (name: string, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

it.effect("a No project chat records the agent's project suggestion", () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    const result = yield* call("t3_thread_suggest_project", {
      projectId: targetProjectId,
      reason: "HQ tasks for a client",
    });
    expect(result.isError).toBe(false);
    expect(dispatched).toMatchObject([
      {
        type: "thread.metadata.update",
        threadId,
        projectSuggestion: { projectId: targetProjectId, reason: "HQ tasks for a client" },
      },
    ]);
  }).pipe(Effect.provide(layerFor(scratchProjectId, dispatched)));
});

it.effect("a chat already in a project cannot be suggested", () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    const suggested = yield* call("t3_thread_suggest_project", {
      projectId: targetProjectId,
      reason: "Belongs elsewhere",
    });
    expect(declaredFailure(suggested)).toMatchObject({ code: "invalid_request" });
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(layerFor(ProjectId.make("project:other"), dispatched)));
});

it.effect("a refused move reaches the agent as an invalid request", () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    const moved = yield* call("t3_thread_move_to_project", {
      projectId: ProjectId.make("project:missing"),
    });
    expect(declaredFailure(moved)).toMatchObject({ code: "invalid_request" });
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(layerFor(scratchProjectId, dispatched)));
});

it.effect("moves the chat in place and queues the continuation as its next turn", () => {
  const moves: Array<ThreadProjectMoveInput> = [];
  return Effect.gen(function* () {
    const result = yield* call("t3_thread_move_to_project", {
      projectId: targetProjectId,
      continuationPrompt: "Continue the chaser email.",
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ sequence: 7 });
    expect(moves).toMatchObject([
      {
        threadId,
        projectId: targetProjectId,
        continuation: { text: "Continue the chaser email." },
      },
    ]);
  }).pipe(Effect.provide(layerFor(scratchProjectId, [], moves)));
});
