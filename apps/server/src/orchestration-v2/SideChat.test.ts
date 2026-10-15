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
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
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
