import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadProjectMove from "./ThreadProjectMoveService.ts";

const scratchId = ProjectId.make("scratch");
const targetId = ProjectId.make("target");
const threadId = ThreadId.make("chat");
const commandId = CommandId.make("move");

interface Thread {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly archivedAt?: string | null;
  readonly workspaceAttachments?: ReadonlyArray<unknown>;
  readonly projectMove?: unknown;
  readonly agentTask?: unknown;
}

/** The move service over recording fakes: `thread` is what the chat looks like now. */
const setup = (input: {
  readonly thread: Thread;
  readonly runs?: number;
  readonly receipt?: boolean;
  readonly dispatchFails?: boolean;
  readonly schedulesFail?: boolean;
  readonly slipjay?: boolean;
}) => {
  const log: Array<string> = [];
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const sent: Array<ThreadManagement.ThreadManagementSendInput> = [];
  const thread = {
    id: threadId,
    title: "Chaser email",
    providerInstanceId: ProviderInstanceId.make("codex"),
    branch: null,
    archivedAt: null,
    ...input.thread,
  };
  const layer = ThreadProjectMove.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread,
              runs: Array.from({ length: input.runs ?? 1 }),
            } as never),
          hasReceipt: () => Effect.succeed(input.receipt ?? false),
          assertProviderInstanceEnabled: () => Effect.void,
          dispatch: (command) => {
            dispatched.push(command);
            log.push(`dispatch:${command.type}`);
            return input.dispatchFails
              ? Effect.fail({ message: "lost" } as never)
              : Effect.succeed({ sequence: 1 } as never);
          },
          sendToThread: (send) => {
            sent.push(send);
            return Effect.succeed({} as never);
          },
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            Effect.succeed(
              Option.some({ id, title: id, workspaceRoot: `/projects/${id}` } as never),
            ),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/unused",
          isScratchProject: (id) => Effect.succeed(id === scratchId),
        }),
        Layer.mock(WorkspaceProvider.WorkspaceProvider)({
          contains: () => Effect.succeed(true),
          resolve: () => Effect.succeed(input.slipjay === false ? "git-worktree" : "slipjay"),
        }),
        Layer.mock(ScheduledTasks.ScheduledTaskService)({
          moveThreadProject: ({ projectId }) =>
            input.schedulesFail
              ? Effect.fail({ message: "schedules" } as never)
              : Effect.sync(() => void log.push(`schedules:${projectId}`)),
        }),
      ),
    ),
  );
  const run = <A, E>(
    f: (service: ThreadProjectMove.ThreadProjectMoveService["Service"]) => Effect.Effect<A, E>,
  ) => Effect.flatMap(ThreadProjectMove.ThreadProjectMoveService, f).pipe(Effect.provide(layer));
  return { log, dispatched, sent, run };
};

const applied = (command: OrchestrationV2ServerCommand | undefined) =>
  command?.type === "thread.project-move.record" && command.change.action === "apply"
    ? command.change
    : undefined;

it.effect("moves a No project chat at once and leaves its workspace to the next turn", () =>
  Effect.gen(function* () {
    const fake = setup({ thread: { projectId: scratchId, worktreePath: "/scratch/chat" } });
    yield* fake.run((service) =>
      service.move({
        commandId,
        threadId,
        projectId: targetId,
        continuation: {
          commandId: CommandId.make("move:continuation"),
          messageId: MessageId.make("move:continuation"),
          text: "Carry on with the chaser.",
          senderThreadId: ThreadId.make("lead"),
        },
      }),
    );
    assert.deepEqual(fake.log, ["dispatch:thread.project-move.record", `schedules:${targetId}`]);
    assert.deepInclude(applied(fake.dispatched[0]), {
      fromProjectId: scratchId,
      projectId: targetId,
      worktreePath: null,
      pendingWorkspace: true,
    });
    assert.equal(fake.sent[0]?.senderThreadId, ThreadId.make("lead"));
    assert.equal(fake.sent[0]?.mode, "queue");
  }),
);

it.effect("runs a chat moved into a project without SlipJay at the project root", () =>
  Effect.gen(function* () {
    const fake = setup({
      slipjay: false,
      thread: { projectId: scratchId, worktreePath: "/scratch/chat" },
    });
    yield* fake.run((service) => service.move({ commandId, threadId, projectId: targetId }));
    assert.deepInclude(applied(fake.dispatched[0]), {
      worktreePath: null,
      pendingWorkspace: false,
    });
  }),
);

it.effect("promotes a workspace the chat already holds in the project", () =>
  Effect.gen(function* () {
    const fake = setup({
      thread: {
        projectId: scratchId,
        worktreePath: "/scratch/chat",
        workspaceAttachments: [
          { projectId: targetId, workspacePath: "/w/held", branch: "held", releasedAt: null },
        ],
      },
    });
    yield* fake.run((service) => service.move({ commandId, threadId, projectId: targetId }));
    assert.deepInclude(applied(fake.dispatched[0]), {
      worktreePath: "/w/held",
      branch: "held",
      pendingWorkspace: false,
    });
  }),
);

it.effect("refuses a chat that is not in No project", () =>
  Effect.gen(function* () {
    const fake = setup({ thread: { projectId: ProjectId.make("other"), worktreePath: null } });
    const error = yield* fake
      .run((service) => service.move({ commandId, threadId, projectId: targetId }))
      .pipe(Effect.flip);
    assert.equal(error.message, "Only a No project chat can move into a project.");
    assert.deepEqual(fake.dispatched, []);
  }),
);

it.effect("refuses a delegated task, whose workspace its lead assigned", () =>
  Effect.gen(function* () {
    const fake = setup({
      thread: { projectId: scratchId, worktreePath: "/scratch/chat", agentTask: {} },
    });
    const error = yield* fake
      .run((service) => service.move({ commandId, threadId, projectId: targetId }))
      .pipe(Effect.flip);
    assert.equal(
      error.message,
      "A delegated task works where its lead assigned it, so it cannot move.",
    );
    assert.deepEqual(fake.dispatched, []);
  }),
);

it.effect("a move that fails to record reports it and changes nothing else", () =>
  Effect.gen(function* () {
    const fake = setup({
      dispatchFails: true,
      thread: { projectId: scratchId, worktreePath: "/scratch/chat" },
    });
    const error = yield* fake
      .run((service) => service.move({ commandId, threadId, projectId: targetId }))
      .pipe(Effect.flip);
    assert.equal(error.message, "Unable to move the chat: lost");
    assert.deepEqual(fake.log, ["dispatch:thread.project-move.record"]);
  }),
);

it.effect("a move stands, and continues, when its scheduled tasks fail to follow", () =>
  Effect.gen(function* () {
    const fake = setup({
      schedulesFail: true,
      thread: { projectId: scratchId, worktreePath: "/scratch/chat" },
    });
    yield* fake.run((service) =>
      service.move({
        commandId,
        threadId,
        projectId: targetId,
        continuation: {
          commandId: CommandId.make("move:continuation"),
          messageId: MessageId.make("move:continuation"),
          text: "Carry on.",
          senderThreadId: threadId,
        },
      }),
    );
    assert.equal(fake.sent.length, 1);
  }),
);

const moved = {
  projectId: targetId,
  worktreePath: null,
  projectMove: { fromProjectId: scratchId, pendingWorkspace: true, runCount: 1 },
};

it.effect("Undo moves the chat back, then its scheduled tasks", () =>
  Effect.gen(function* () {
    const fake = setup({ thread: moved });
    yield* fake.run((service) => service.undo({ commandId: CommandId.make("undo"), threadId }));
    assert.deepEqual(fake.log, ["dispatch:thread.project-move.record", `schedules:${scratchId}`]);
  }),
);

it.effect("Undo is refused once the chat has run in the project", () =>
  Effect.gen(function* () {
    const fake = setup({ thread: moved, runs: 2 });
    const error = yield* fake
      .run((service) => service.undo({ commandId: CommandId.make("undo"), threadId }))
      .pipe(Effect.flip);
    assert.equal(
      error.message,
      "The chat has run in the project since it moved, so it stays there.",
    );
    assert.deepEqual(fake.log, []);
  }),
);
