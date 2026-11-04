import { assert, it } from "@effect/vitest";
import {
  OrchestrationV2ProviderThreadJson,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as AgentMcpServers from "./AgentMcpServers.ts";
import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";

const decodeThread = Schema.decodeUnknownEffect(OrchestrationV2ProviderThreadJson);
const encodeThread = Schema.encodeEffect(OrchestrationV2ProviderThreadJson);

const threadId = ThreadId.make("registration-fixture");
const thread = (): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make("provider-thread"),
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: ProviderSessionId.make("session"),
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: {
    driver: ProviderDriverKind.make("codex"),
    nativeId: "native-fixture",
    strength: "strong",
  },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [],
  contextUsage: null,
  nativeMetadata: null,
  goal: null,
  createdAt: DateTime.makeUnsafe("2026-11-04T00:00:00Z"),
  updatedAt: DateTime.makeUnsafe("2026-11-04T00:00:00Z"),
});

const fixture = Effect.gen(function* () {
  const observed: AgentMcpServers.Registration[] = [];
  const read = yield* AgentMcpServers.makeReader.pipe(
    Effect.provideService(
      AgentMcpServers.AgentMcpServers,
      AgentMcpServers.AgentMcpServers.of({
        read: (_threadId, registration) =>
          Effect.sync(() => {
            observed.push(registration!);
            return [];
          }),
      }),
    ),
  );
  const runtime = {
    events: Stream.make({
      type: "provider_thread.updated" as const,
      driver: "codex" as const,
      providerThread: thread(),
    }),
    ensureThread: () => read(threadId).pipe(Effect.as(thread())),
    resumeThread: () => read(threadId).pipe(Effect.as(thread())),
    forkThread: () => read(threadId).pipe(Effect.as(thread())),
    startTurn: () => read(threadId).pipe(Effect.asVoid),
    readThreadSnapshot: () =>
      read(threadId).pipe(
        Effect.as({
          providerThread: thread(),
          providerTurns: [],
          messages: [],
          runtimeRequests: [],
        }),
      ),
    rollbackThread: () =>
      read(threadId).pipe(
        Effect.as({
          providerThread: thread(),
          providerTurns: [],
          messages: [],
          runtimeRequests: [],
        }),
      ),
  } as unknown as ProviderAdapterV2SessionRuntime;
  return { runtime, observed };
});

it.effect(
  "fresh native sessions in an old app thread persist canonical registration across restart",
  () =>
    Effect.gen(function* () {
      const { runtime, observed } = yield* fixture;
      const bound = AgentMcpServers.bindRuntime(runtime);
      const fresh = yield* bound.ensureThread({
        threadId,
        existingProviderThread: { ...thread(), nativeThreadRef: null },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
        runtimePolicy: {} as never,
      });
      assert.strictEqual(fresh.nativeMetadata?.agentMcpRegistration, "canonical");
      const restored = yield* decodeThread(yield* encodeThread(fresh));
      const reopened = AgentMcpServers.bindRuntime(runtime);
      const resumed = yield* reopened.resumeThread({ providerThread: restored });
      assert.strictEqual(resumed.nativeMetadata?.agentMcpRegistration, "canonical");
      assert.deepStrictEqual(observed, ["canonical", "canonical"]);
    }),
);

it.effect(
  "unmarked native sessions and their forks keep legacy registrations and asynchronous updates",
  () =>
    Effect.gen(function* () {
      const { runtime, observed } = yield* fixture;
      const bound = AgentMcpServers.bindRuntime(runtime);
      const resumed = yield* bound.resumeThread({ providerThread: thread() });
      const forked = yield* bound.forkThread({
        sourceProviderThread: resumed,
        targetThreadId: threadId,
      });
      assert.strictEqual(forked.nativeMetadata?.agentMcpRegistration, "legacy");
      const events = yield* bound.events.pipe(Stream.runCollect);
      assert.strictEqual(
        events[0]?.type === "provider_thread.updated" &&
          events[0].providerThread.nativeMetadata?.agentMcpRegistration,
        "legacy",
      );
      assert.deepStrictEqual(observed, ["legacy", "legacy"]);
    }),
);

it.effect("canonical forks, snapshot loading and rollback keep their durable choice", () =>
  Effect.gen(function* () {
    const { runtime, observed } = yield* fixture;
    const canonical = {
      ...thread(),
      nativeMetadata: { agentMcpRegistration: "canonical" as const },
    };
    const bound = AgentMcpServers.bindRuntime(runtime);
    const forked = yield* bound.forkThread({
      sourceProviderThread: canonical,
      targetThreadId: threadId,
    });
    yield* bound.readThreadSnapshot({ providerThread: forked });
    yield* bound.rollbackThread({ providerThread: forked } as never);
    assert.deepStrictEqual(observed, ["canonical", "canonical", "canonical"]);
  }),
);

it.effect("late legacy events cannot change a replacement native session's choice", () =>
  Effect.gen(function* () {
    const { runtime } = yield* fixture;
    const freshNative = {
      ...thread(),
      nativeThreadRef: { ...thread().nativeThreadRef!, nativeId: "replacement-native" },
    };
    const bound = AgentMcpServers.bindRuntime({
      ...runtime,
      ensureThread: () => Effect.succeed(freshNative),
    });
    yield* bound.resumeThread({ providerThread: thread() });
    const fresh = yield* bound.ensureThread({
      threadId,
      existingProviderThread: { ...thread(), nativeThreadRef: null },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
      runtimePolicy: {} as never,
    });
    const events = yield* bound.events.pipe(Stream.runCollect);
    assert.strictEqual(
      events[0]?.type === "provider_thread.updated" &&
        events[0].providerThread.nativeMetadata?.agentMcpRegistration,
      "legacy",
    );
    assert.strictEqual(fresh.nativeMetadata?.agentMcpRegistration, "canonical");
  }),
);
