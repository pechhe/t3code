import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { SCHEDULED_TASK_NOTE } from "./ScheduledTaskPrompt.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const projectId = ProjectId.make("turn-notes-project");
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Side chat tests do not run provider turns"),
};
/** Records the text each provider turn receives, then leaves the turn running. */
const recordingLayer = (started: Deferred.Deferred<string>) =>
  ProviderReplayHarness.layerWithRegistry(
    { name: "turn-notes-note" },
    ProviderAdapterRegistry.layerFromAdapters([
      {
        ...adapter,
        openSession: (sessionInput) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: sessionInput.providerSessionId,
              providerSession: {
                id: sessionInput.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
                model: sessionInput.modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.never,
              ensureThread: (threadInput: { readonly threadId: ThreadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: sessionInput.providerSessionId,
                  appThreadId: threadInput.threadId,
                  ownerNodeId: null,
                  nativeThreadRef: {
                    driver,
                    nativeId: `native:${threadInput.threadId}`,
                    strength: "strong",
                  },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }: { readonly providerThread: unknown }) =>
                Effect.succeed(providerThread),
              startTurn: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                Deferred.succeed(started, input.message.text).pipe(Effect.asVoid),
              steerTurn: () => Effect.void,
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
            } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
          }),
      },
    ]),
  );

it.effect("lists the thread's workspaces in each turn once it has one attached", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<string>();
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("workspaces-note");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-workspaces-note"),
        threadId,
        projectId,
        title: "Workspaces note",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      // Recorded directly: the note depends only on the thread's attachments.
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make("attach-workspaces-note"),
        events: [
          {
            id: EventId.make("workspaces-note-attachment"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: instanceId,
            occurredAt: yield* DateTime.now,
            payload: {
              ...(yield* orchestrator.getThreadProjection(threadId)).thread,
              workspaceAttachments: [
                {
                  projectId: ProjectId.make("api-project"),
                  workspacePath: "/workspaces/api",
                  branch: "feature/api",
                  origin: "allocated",
                  attachedAt: "2026-10-19T09:00:00.000Z",
                  releasedAt: null,
                },
              ],
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("ask-workspaces-note"),
        threadId,
        messageId: MessageId.make("ask-workspaces-note"),
        text: "Carry on.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
    }).pipe(Effect.provide(recordingLayer(started)));

    const text = yield* Deferred.await(started);
    assert.include(text, "turn-notes-project (primary, where this session runs)");
    assert.include(text, "api-project (attached): /workspaces/api on feature/api");
    assert.isTrue(text.endsWith("Carry on."));
  }),
);

it.effect("tells the provider a scheduled prompt is not a message from the user", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<string>();
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("scheduled-prompt-note");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-scheduled-prompt-note"),
        threadId,
        projectId,
        title: "Scheduled prompt note",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("scheduled-prompt"),
        threadId,
        messageId: MessageId.make("scheduled-prompt"),
        scheduledTaskId: ScheduledTaskId.make("heartbeat"),
        text: "Check the release.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "mcp",
      });
      yield* worker.drain();
    }).pipe(Effect.provide(recordingLayer(started)));

    const text = yield* Deferred.await(started);
    assert.include(text, SCHEDULED_TASK_NOTE);
    assert.include(text, "Scheduled task prompt:\nCheck the release.");
    assert.notInclude(text, "User message:");
  }),
);

it.effect("sends an ordinary user message without the scheduled framing", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<string>();
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("ordinary-prompt");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-ordinary-prompt"),
        threadId,
        projectId,
        title: "Ordinary prompt",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("ordinary-prompt"),
        threadId,
        messageId: MessageId.make("ordinary-prompt"),
        text: "Check the release.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
    }).pipe(Effect.provide(recordingLayer(started)));

    const text = yield* Deferred.await(started);
    assert.notInclude(text, SCHEDULED_TASK_NOTE);
    assert.notInclude(text, "Scheduled task prompt:");
    assert.isTrue(text.endsWith("Check the release."));
  }),
);
