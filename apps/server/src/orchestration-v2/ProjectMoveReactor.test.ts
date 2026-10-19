import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectMoveReactor from "./ProjectMoveReactor.ts";

const threadId = ThreadId.make("thread:no-project");
const targetThreadId = ThreadId.make("thread:moved");
const projectId = ProjectId.make("project:yardsmith");

interface Fixture {
  readonly runStatuses: ReadonlyArray<string>;
  readonly dismissed?: boolean;
  readonly archived?: boolean;
}

const layerFor = (fixture: Fixture, dispatched: Array<OrchestrationV2ServerCommand>) =>
  ProjectMoveReactor.layer.pipe(
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command as OrchestrationV2ServerCommand);
            return { sequence: dispatched.length } as never;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: {
              id: threadId,
              title: "Landing speed",
              archivedAt: fixture.archived === true ? DateTime.nowUnsafe() : null,
              deletedAt: null,
              projectSuggestion: {
                projectId,
                reason: "Moving here as asked in this chat.",
                suggestedAt: DateTime.nowUnsafe(),
                dismissedAt: fixture.dismissed === true ? DateTime.nowUnsafe() : null,
                move: { targetThreadId, continuation: "Continue leading #2433." },
              },
            },
            runs: fixture.runStatuses.map((status) => ({ status })),
          } as never),
      }),
    ),
    Layer.provide(SqlitePersistence.layerMemory),
  );

const runEnded = {
  type: "run.updated",
  threadId,
  payload: { status: "completed" },
} as unknown as OrchestrationV2DomainEvent;

const handle = (event: OrchestrationV2DomainEvent) =>
  ProjectMoveReactor.ProjectMoveReactor.pipe(Effect.flatMap((reactor) => reactor.handle(event)));

it.effect("moves the chat once its turn ends and continues there", () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* handle(runEnded);
    expect(dispatched).toMatchObject([
      {
        type: "thread.fork",
        sourceThreadId: threadId,
        targetThreadId,
        sourcePoint: { type: "latest_finished" },
        projectId,
        moveWorkspaceAttachments: true,
      },
      { type: "message.dispatch", threadId: targetThreadId, text: "Continue leading #2433." },
      { type: "thread.archive", threadId },
    ]);
  }).pipe(Effect.provide(layerFor({ runStatuses: ["completed"] }, dispatched)));
});

it.effect("waits while another run is still active or queued", () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* handle(runEnded);
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(layerFor({ runStatuses: ["completed", "queued"] }, dispatched)));
});

it.effect("Keep cancels a move not yet made", () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* handle(runEnded);
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(layerFor({ runStatuses: ["completed"], dismissed: true }, dispatched)));
});

it.effect("does nothing once the chat has moved", () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    yield* handle(runEnded);
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(layerFor({ runStatuses: ["completed"], archived: true }, dispatched)));
});
