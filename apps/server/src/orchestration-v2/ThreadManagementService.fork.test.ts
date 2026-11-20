import { type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

/** Builds a command against one Pi account while another account of the same instance has allowance. */
it.effect("blocks agent messages to external work backing threads before dispatch", () => {
  const projectId = ProjectId.make("project:thread-management:external-owner");
  const externalThreadId = ThreadId.make("thread:thread-management:external-owner");
  const ordinaryThreadId = ThreadId.make("thread:thread-management:ordinary");
  const instanceId = ProviderInstanceId.make("codex");
  const environmentId = EnvironmentId.make("environment:thread-management:external-owner");
  const externalOwner = {
    environmentId,
    clientSessionId: "external-client",
    externalSessionKey: "a".repeat(64),
    projectId,
    ceiling: "full-access" as const,
  };
  const dispatched: Array<
    Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>
  > = [];
  let projection = {
    thread: {
      id: externalThreadId,
      projectId,
      deletedAt: null,
      archivedAt: null,
      modelSelection: { instanceId, model: "test-model" },
    },
    runs: [],
    providerTurns: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadRecords: () => Effect.succeed(projection),
        getThreadShell: (threadId) =>
          Effect.succeed(
            threadId === externalThreadId
              ? ({
                  id: externalThreadId,
                  agentTask: { externalOwner },
                } as never)
              : null,
          ),
        dispatch: (command) =>
          Effect.sync(() => {
            if (command.type === "message.dispatch") dispatched.push(command);
            if (
              command.type === "message.dispatch" &&
              command.threadId === externalThreadId &&
              command.createdBy === "agent"
            ) {
              const runId = RunId.make("run:owned-external-followup");
              projection = {
                ...projection,
                messages: [
                  { id: command.messageId, runId } as (typeof projection.messages)[number],
                ],
                runs: [{ id: runId, status: "queued" } as (typeof projection.runs)[number]],
              };
            }
            return { sequence: dispatched.length, storedEvents: [] } as never;
          }),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
      }),
    ),
    Layer.provide(layerReceiptsTest),
  );

  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const message = (threadId: ThreadId, createdBy: "agent" | "user", suffix: string) => ({
      type: "message.dispatch" as const,
      commandId: CommandId.make(`command:thread-management:external-owner:${suffix}`),
      threadId,
      messageId: MessageId.make(`message:thread-management:external-owner:${suffix}`),
      text: "A message",
      attachments: [],
      dispatchMode: { type: "start_immediately" as const },
      createdBy,
      creationSource: createdBy === "agent" ? ("mcp" as const) : ("web" as const),
    });

    const sendError = yield* Effect.flip(
      threads.sendToThread({
        projectId,
        commandId: CommandId.make("command:thread-management:external-owner:send"),
        threadId: externalThreadId,
        messageId: MessageId.make("message:thread-management:external-owner:send"),
        text: "Try to continue through the raw backing thread",
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "mcp",
      }),
    );
    expect(sendError).toMatchObject({ _tag: "OrchestratorCommandRejectedError" });

    const directError = yield* Effect.flip(
      threads.dispatch(message(externalThreadId, "agent", "direct")),
    );
    expect(directError).toMatchObject({ _tag: "OrchestratorCommandRejectedError" });
    expect(dispatched).toEqual([]);

    const followup = {
      projectId,
      threadId: externalThreadId,
      commandId: CommandId.make("command:owned-external-followup"),
      messageId: MessageId.make("message:owned-external-followup"),
      text: "Continue the owned task",
      attachments: [],
      mode: "queue" as const,
      createdBy: "agent" as const,
      creationSource: "mcp" as const,
      followupSourceRevision: "current-source",
      externalWorkOwner: externalOwner,
    };
    const foreign = yield* threads
      .sendToThread({
        ...followup,
        externalWorkOwner: { ...externalOwner, externalSessionKey: "foreign-owner" },
      })
      .pipe(Effect.flip);
    expect(foreign).toMatchObject({ _tag: "OrchestratorCommandRejectedError" });
    expect(dispatched).toEqual([]);
    expect((yield* threads.sendToThread(followup)).delivery).toBe("queued");
    expect(dispatched).toHaveLength(1);
    dispatched.length = 0;

    // A task launched without a source revision continues without one, still as its owner.
    const { followupSourceRevision: _stated, ...unpinned } = followup;
    const foreignUnpinned = yield* threads
      .sendToThread({
        ...unpinned,
        commandId: CommandId.make("command:owned-external-unpinned-foreign"),
        externalWorkOwner: { ...externalOwner, externalSessionKey: "foreign-owner" },
      })
      .pipe(Effect.flip);
    expect(foreignUnpinned).toMatchObject({ _tag: "OrchestratorCommandRejectedError" });
    expect(dispatched).toEqual([]);
    expect(
      (yield* threads.sendToThread({
        ...unpinned,
        commandId: CommandId.make("command:owned-external-unpinned"),
        messageId: MessageId.make("message:owned-external-unpinned"),
      })).delivery,
    ).toBe("queued");
    expect(dispatched).toHaveLength(1);
    dispatched.length = 0;

    yield* threads.dispatch(message(externalThreadId, "user", "human"));
    yield* threads.dispatch(message(ordinaryThreadId, "agent", "ordinary-agent"));
    // The launch of the work itself delivers its first message through `defer_start`.
    yield* threads.dispatch({
      ...message(externalThreadId, "agent", "launch"),
      dispatchMode: { type: "defer_start" as const, workspaceStrategy: { type: "root" as const } },
    });
    expect(dispatched.map((command) => [command.threadId, command.createdBy])).toEqual([
      [externalThreadId, "user"],
      [ordinaryThreadId, "agent"],
      [externalThreadId, "agent"],
    ]);
  }).pipe(Effect.provide(layerTest));
});

it.effect(
  "retains a champion owner's thread and workspace while accepted children are live",
  () => {
    const threadId = ThreadId.make("champion:owner");
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              champion: { id: "quality", attention: true },
            } as OrchestrationV2ThreadShell),
          getThreadRecords: () =>
            Effect.succeed({
              subagents: [{ origin: "app_owned", childThreadId: "child", status: "running" }],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: () =>
            Effect.die("A live champion owner's archive/replacement must not reach dispatch."),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const commands: OrchestrationV2ServerCommand[] = [
      { type: "thread.archive", threadId, commandId: CommandId.make("champion:archive") },
      { type: "thread.delete", threadId, commandId: CommandId.make("champion:delete") },
      {
        type: "thread.metadata.update",
        threadId,
        commandId: CommandId.make("champion:replace"),
        worktreePath: "/replacement",
      },
    ];
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      for (const command of commands) {
        const error = yield* threads.dispatch(command).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestratorCommandRejectedError");
      }
    }).pipe(Effect.provide(layerTest));
  },
);
