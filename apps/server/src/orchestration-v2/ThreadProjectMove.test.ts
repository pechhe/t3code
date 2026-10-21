import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const scratchProjectId = ProjectId.make("project-move-scratch");
const targetProjectId = ProjectId.make("project-move-target");
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Project move tests do not run provider turns"),
};
const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "thread-project-move" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

const seedProject = (projectId: ProjectId, workspaceRoot: string) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-10-16T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-16T00:00:00.000Z",
        updatedAt: "2026-10-16T00:00:00.000Z",
      },
    }),
  );

/** A No project chat in its own Scratch folder, with one finished turn. */
const createScratchThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const runId = RunId.make(`${threadId}:run`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: scratchProjectId,
      title: "Chaser email",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/scratch/2026-10-16-chaser-email",
      createdBy: "user",
      creationSource: "web",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${threadId}:run`),
          type: "run.created",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`${threadId}:message`),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            queuePosition: null,
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    return runId;
  });

it.effect("records one project suggestion per chat and keeps a dismissal final", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("project-move-suggestion");
    yield* createScratchThread(threadId);

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("project-move-suggestion-set"),
      threadId,
      projectSuggestion: { projectId: targetProjectId, reason: "HQ tasks and a client chaser" },
    });
    const suggested = (yield* orchestrator.getThreadProjection(threadId)).thread.projectSuggestion;
    assert.equal(suggested?.projectId, targetProjectId);
    assert.equal(suggested?.reason, "HQ tasks and a client chaser");
    assert.isNull(suggested?.dismissedAt);

    const second = yield* orchestrator
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("project-move-suggestion-again"),
        threadId,
        projectSuggestion: { projectId: targetProjectId, reason: "Again" },
      })
      .pipe(Effect.flip);
    assert.include(String(second.cause ?? second.message), "already has a project suggestion");

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("project-move-suggestion-keep"),
      threadId,
      projectSuggestion: "dismissed",
    });
    const dismissed = (yield* orchestrator.getThreadProjection(threadId)).thread.projectSuggestion;
    assert.equal(dismissed?.reason, "HQ tasks and a client chaser");
    assert.isNotNull(dismissed?.dismissedAt);
  }).pipe(Effect.provide(layer)),
);
