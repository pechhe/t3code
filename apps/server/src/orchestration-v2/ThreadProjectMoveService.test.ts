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
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadProjectMove from "./ThreadProjectMoveService.ts";
import * as WorkspaceAttachments from "./WorkspaceAttachments.ts";

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
}

/** The move service over recording fakes: `thread` is what the chat looks like now. */
const setup = (input: {
  readonly thread: Thread;
  readonly runs?: number;
  readonly receipt?: boolean;
  readonly dispatchFails?: boolean;
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
          release: ({ path }) => Effect.sync(() => void log.push(`release:${path}`)),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          allocateProjectWorkspace: () =>
            Effect.sync(() => {
              log.push("allocate");
              return { worktreePath: "/w/new", workspaceIssue: null, allocated: true };
            }),
        }),
        Layer.mock(WorkspaceAttachments.WorkspaceAttachments)({
          releaseWorkspace: ({ workspacePath }) =>
            Effect.sync(() => void log.push(`releaseWorkspace:${workspacePath}`)),
        }),
        Layer.mock(ScheduledTasks.ScheduledTaskService)({
          moveThreadProject: ({ projectId }) =>
            Effect.sync(() => void log.push(`schedules:${projectId}`)),
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

it.effect("moves a No project chat into a fresh project workspace and continues there", () =>
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
        },
      }),
    );
    assert.deepEqual(fake.log, [
      "allocate",
      "dispatch:thread.project-move.record",
      `schedules:${targetId}`,
    ]);
    assert.deepInclude(applied(fake.dispatched[0]), {
      projectId: targetId,
      worktreePath: "/w/new",
      allocatedWorkspace: true,
    });
    assert.equal(fake.sent[0]?.senderThreadId, threadId);
    assert.equal(fake.sent[0]?.mode, "queue");
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
    assert.notInclude(fake.log, "allocate");
    assert.deepInclude(applied(fake.dispatched[0]), {
      worktreePath: "/w/held",
      branch: "held",
      allocatedWorkspace: false,
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

it.effect("a retry replays the recorded move without allocating again", () =>
  Effect.gen(function* () {
    const fake = setup({
      receipt: true,
      thread: {
        projectId: targetId,
        worktreePath: "/w/new",
        projectMove: { allocatedWorkspace: true },
      },
    });
    yield* fake.run((service) => service.move({ commandId, threadId, projectId: targetId }));
    assert.notInclude(fake.log, "allocate");
    assert.deepInclude(applied(fake.dispatched[0]), {
      worktreePath: "/w/new",
      allocatedWorkspace: true,
    });
  }),
);

it.effect("releases the allocated workspace when the move fails to record", () =>
  Effect.gen(function* () {
    const fake = setup({
      dispatchFails: true,
      thread: { projectId: scratchId, worktreePath: "/scratch/chat" },
    });
    yield* fake
      .run((service) => service.move({ commandId, threadId, projectId: targetId }))
      .pipe(Effect.flip);
    assert.deepEqual(fake.log, [
      "allocate",
      "dispatch:thread.project-move.record",
      "release:/w/new",
    ]);
  }),
);

const moved = {
  projectId: targetId,
  worktreePath: "/w/new",
  projectMove: { fromProjectId: scratchId, allocatedWorkspace: true, runCount: 1 },
};

it.effect("Undo releases the workspace the move allocated, then moves the chat back", () =>
  Effect.gen(function* () {
    const fake = setup({ thread: moved });
    yield* fake.run((service) => service.undo({ commandId: CommandId.make("undo"), threadId }));
    assert.deepEqual(fake.log, [
      "releaseWorkspace:/w/new",
      "dispatch:thread.project-move.record",
      `schedules:${scratchId}`,
    ]);
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
