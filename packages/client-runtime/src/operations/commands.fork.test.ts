import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  type ProjectMutation,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import * as SecureRandom from "effect/crypto/SecureRandom";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import { createThread, setThreadStance, startThreadTurn } from "./commands.ts";

const layerTestRandom = Layer.succeed(
  SecureRandom.SecureRandom,
  SecureRandom.make((size) => new Uint8Array(size)),
);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const CONNECTED_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  phase: "connected",
};

const makeSupervisor = Effect.fn("TestEnvironmentCommands.makeSupervisor")(function* (input: {
  readonly commands: OrchestrationV2Command[];
  readonly projects: ProjectMutation[];
  readonly launches?: OrchestrationV2ThreadLaunchInput[];
  readonly projection?: OrchestrationV2ThreadProjection;
  readonly projectionRequests?: ThreadId[];
  readonly advertiseThreadStop?: boolean;
  readonly advertiseServerResolvedCommandContext?: boolean;
}) {
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
      Effect.sync(() => {
        input.commands.push(command);
        return { sequence: input.commands.length };
      }),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (requestInput: {
      readonly threadId: ThreadId;
    }) =>
      Effect.sync(() => {
        input.projectionRequests?.push(requestInput.threadId);
        return input.projection ?? v2Projection;
      }),
    [ORCHESTRATION_V2_WS_METHODS.launchThread]: (launchInput: OrchestrationV2ThreadLaunchInput) =>
      Effect.sync(() => {
        input.launches?.push(launchInput);
        return {
          threadId: launchInput.threadId ?? v2ThreadId,
          projection: input.projection ?? v2Projection,
          resumed: false,
        };
      }),
    [WS_METHODS.projectsMutate]: (mutation: ProjectMutation) =>
      Effect.sync(() => {
        input.projects.push(mutation);
        return {
          id: mutation.projectId,
          title: mutation.type === "project.create" ? mutation.title : "Project",
          workspaceRoot:
            mutation.type === "project.create" ? mutation.workspaceRoot : "/workspace/project",
          repositoryIdentity: null,
          faviconPath: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-06-06T00:00:00.000Z",
          updatedAt: "2026-06-06T00:00:00.000Z",
          deletedAt: null,
        };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({
      environment: {
        capabilities: {
          repositoryIdentity: true,
          ...(input.advertiseServerResolvedCommandContext === false
            ? {}
            : { serverResolvedCommandContext: true }),
          ...(input.advertiseThreadStop === true ? { threadStop: true } : {}),
        },
      },
    } as never),
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(CONNECTED_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

describe("V2 environment commands", () => {
  it.effect("forwards stanceChoice on thread creation and thread.stance.set", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const launches: OrchestrationV2ThreadLaunchInput[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [], launches });

      yield* createThread({
        commandId: CommandId.make("create-with-stance"),
        threadId: v2ThreadId,
        projectId: ProjectId.make("project-1"),
        title: "Stance thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        stanceChoice: { stance: "orchestrate", chosenBy: "owner" },
        branch: null,
        worktreePath: null,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      yield* startThreadTurn({
        commandId: CommandId.make("launch-with-stance"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("msg-stance"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project-1"),
            title: "Stance launch",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            stanceChoice: { stance: "implement", chosenBy: "owner" },
            branch: null,
            worktreePath: null,
            createdAt: "2026-06-06T00:00:00.000Z",
          },
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      yield* setThreadStance({
        commandId: CommandId.make("set-stance"),
        threadId: v2ThreadId,
        stance: "flexible",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        expect.objectContaining({
          type: "thread.create",
          commandId: "create-with-stance",
          stanceChoice: { stance: "orchestrate", chosenBy: "owner" },
        }),
        {
          type: "thread.stance.set",
          commandId: "set-stance",
          threadId: v2ThreadId,
          stance: "flexible",
        },
      ]);
      expect(launches).toEqual([
        expect.objectContaining({
          commandId: "launch-with-stance",
          stanceChoice: { stance: "implement", chosenBy: "owner" },
        }),
      ]);
    }).pipe(Effect.provide(layerTestRandom)),
  );
});
