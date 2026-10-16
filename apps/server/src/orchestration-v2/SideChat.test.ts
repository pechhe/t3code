import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
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
import { SIDE_CHAT_NOTE } from "./ProviderTurnStartService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const projectId = ProjectId.make("side-chat-project");
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Side chat tests do not run provider turns"),
};
const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "side-chat" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

/** Records the text each provider turn receives, then leaves the turn running. */
const recordingLayer = (started: Deferred.Deferred<string>) =>
  ProviderReplayHarness.layerWithRegistry(
    { name: "side-chat-note" },
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

it.effect("tells the provider to answer briefly in a side chat", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<string>();
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("side-chat-note");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-side-chat-note"),
        threadId,
        projectId,
        title: "Side chat note",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      // Marked directly: the note depends only on the flag, not on how the fork was made.
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("side-chat-note-flag"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: instanceId,
            occurredAt: yield* DateTime.now,
            payload: {
              ...(yield* orchestrator.getThreadProjection(threadId)).thread,
              sideChat: true,
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("ask-side-chat"),
        threadId,
        messageId: MessageId.make("ask-side-chat"),
        text: "What does this do?",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
    }).pipe(Effect.provide(recordingLayer(started)));

    const text = yield* Deferred.await(started);
    assert.include(text, SIDE_CHAT_NOTE);
    assert.isTrue(text.endsWith("What does this do?"));
  }),
);

it.effect("opens a side chat from the latest finished turn and keeps it as a fork", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const sourceThreadId = ThreadId.make("side-chat-source");
    const sideChatThreadId = ThreadId.make("side-chat-target");
    const runId = RunId.make("side-chat-source-run");

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-side-chat-source"),
      threadId: sourceThreadId,
      projectId,
      title: "Side chat source",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("side-chat-source-run"),
          type: "run.created",
          threadId: sourceThreadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: sourceThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("side-chat-source-message"),
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

    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("open-side-chat"),
      sourceThreadId,
      targetThreadId: sideChatThreadId,
      sourcePoint: { type: "latest_finished" },
      title: "Side chat source side chat",
      sideChat: true,
      createdBy: "user",
      creationSource: "web",
    });
    const opened = yield* orchestrator.getThreadProjection(sideChatThreadId);
    assert.isTrue(opened.thread.sideChat);
    assert.deepEqual(opened.thread.modelSelection, modelSelection);
    assert.deepEqual(opened.thread.forkedFrom, { type: "run", threadId: sourceThreadId, runId });
    const openedShell = yield* orchestrator.getShellSnapshot({ projectId, location: "active" });
    assert.isTrue(openedShell.threads.find((thread) => thread.id === sideChatThreadId)?.sideChat);

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("keep-side-chat"),
      threadId: sideChatThreadId,
      keepSideChat: true,
    });
    const kept = yield* orchestrator.getThreadProjection(sideChatThreadId);
    assert.isFalse(kept.thread.sideChat);
    const keptShell = yield* orchestrator.getShellSnapshot({ projectId, location: "active" });
    assert.isUndefined(
      keptShell.threads.find((thread) => thread.id === sideChatThreadId)?.sideChat,
    );
  }).pipe(Effect.provide(layer)),
);
