import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as Reactor from "./UnusedThreadExpiryReactor.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const testLayer = () => {
  const database = Sqlite.layerMemory;
  const runtime = ProviderReplayHarness.layerWithRegistry(
    { name: "unused-thread-expiry" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  );
  return Reactor.layer.pipe(
    Layer.provideMerge(runtime),
    Layer.provideMerge(EffectOutbox.layer.pipe(Layer.provide(database))),
    Layer.provide(database),
  );
};

const create = (
  id: string,
  creationSource: "web" | "mcp" | "mobile",
  worktreePath: string | null = null,
) =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:${id}`);
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      threadId,
      projectId: ProjectId.make("project:expiry"),
      title: id,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath,
      createdBy: creationSource === "mcp" ? "agent" : "user",
      creationSource,
    });
    return threadId;
  });

const deleted = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    return (yield* engine.getThreadRecords(threadId, [])).thread.deletedAt != null;
  });

it.effect(
  "deletes a client's top-level thread that sat 30 minutes without a message, and only that",
  () =>
    Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const reactor = yield* Reactor.UnusedThreadExpiryReactor;
      const idle = yield* create("idle", "web");
      const idleMobile = yield* create("idle-mobile", "mobile");
      const agent = yield* create("agent", "mcp");
      const messaged = yield* create("messaged", "web", "/tmp/expiry-worktree");
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("message:messaged"),
        threadId: messaged,
        messageId: MessageId.make("message:messaged"),
        text: "Hello",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const sideChat = ThreadId.make("thread:side-chat");
      yield* engine.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork:side-chat"),
        sourceThreadId: messaged,
        targetThreadId: sideChat,
        sourcePoint: { type: "latest_stable" },
        sideChat: true,
        createdBy: "user",
        creationSource: "mobile",
      });
      yield* TestClock.adjust("20 minutes");
      const fresh = yield* create("fresh", "web");
      yield* TestClock.adjust("11 minutes");
      yield* reactor.sweep;

      assert.deepEqual(
        yield* Effect.forEach([idle, idleMobile, agent, messaged, sideChat, fresh], deleted),
        [true, true, false, false, false, false],
      );
      const requests = (yield* outbox.listByCommandId(
        CommandId.make(`unused-thread-expiry:${idle}`),
      )).map((effect) => effect.request);
      assert.deepInclude(requests, { type: "thread-workspace.release" });
    }).pipe(Effect.provide(testLayer())),
);
