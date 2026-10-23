import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ReplacedWorkspaceOutcome,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import {
  replacedWorkspace,
  replacedWorkspaceNote,
  unreplacedWorkspaceNote,
} from "./ProviderTurnStartService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

interface StartedTurn {
  readonly cwd: string | null;
  readonly input: string;
}

/** Completes every turn at once and records the checkout each one was asked to run in. */
function makeRecordingAdapter(
  driver: ProviderDriverKind,
  capabilities: OrchestrationV2ProviderCapabilities,
  started: Ref.Ref<ReadonlyArray<StartedTurn>>,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  const instanceId = ProviderInstanceId.make(`${driver}-rebind`);
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
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
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:${driver}:${threadInput.threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native-thread:${driver}:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(started, (turns) => [
                ...turns,
                { cwd: input.runtimePolicy.cwd, input: JSON.stringify(input) },
              ]);
              const occurredAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(`provider-turn:${input.attemptId}`);
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${providerTurnId}`,
                    strength: "strong",
                  },
                  ordinal: input.providerTurnOrdinal,
                  status: "completed",
                  startedAt: occurredAt,
                  completedAt: occurredAt,
                },
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: input.providerThread.id,
                providerTurnId,
                runOrdinal: input.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

it.live.each([
  { driver: ProviderDriverKind.make("claudeAgent"), capabilities: ClaudeProviderCapabilitiesV2 },
  { driver: ProviderDriverKind.make("codex"), capabilities: CodexProviderCapabilitiesV2 },
])(
  "runs $driver's next turn in the workspace that replaced a removed one",
  ({ driver, capabilities }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // SlipJay workspaces are siblings, so the replacement never contains the old one.
        const first = `${yield* checkpointWorkspace(`rebind-first-${driver}`)}/workspace`;
        yield* fs.makeDirectory(first);
        const fresh = yield* checkpointWorkspace(`rebind-fresh-${driver}`);
        const threadId = ThreadId.make(`thread:rebind:${driver}`);
        const started = yield* Ref.make<ReadonlyArray<StartedTurn>>([]);
        const adapter = makeRecordingAdapter(driver, capabilities, started);
        const modelSelection = { instanceId: adapter.instanceId, model: "rebind-model" };

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const runTurn = (text: string) =>
            Effect.gen(function* () {
              const completed = yield* eventSink
                .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
                .pipe(
                  Stream.filter(
                    ({ event }) =>
                      event.type === "run.updated" && event.payload.status === "completed",
                  ),
                  Stream.runHead,
                  Effect.forkScoped,
                );
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make(`command:rebind:${driver}:${text}`),
                threadId,
                messageId: MessageId.make(`message:rebind:${driver}:${text}`),
                text,
                attachments: [],
                modelSelection,
                dispatchMode: { type: "start_immediately" },
              });
              yield* Fiber.join(completed);
              yield* worker.drain();
            });

          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:rebind:${driver}:create`),
            threadId,
            projectId: ProjectId.make("project:rebind"),
            title: "Rebind",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: first,
          });
          yield* runTurn("first");
          // SlipJay removed the idle workspace, and recovery bound the thread to a fresh one.
          yield* fs.remove(first, { recursive: true });
          yield* orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`command:rebind:${driver}:rebind`),
            threadId,
            branch: null,
            worktreePath: fresh,
            expectedWorktreePath: first,
            workspaceReplaced: { outcome: "fresh" },
          });
          yield* runTurn("second");
          yield* runTurn("third");
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: `workspace-rebind-${driver}` },
              ProviderAdapterRegistry.layerSingle(adapter),
            ),
          ),
        );

        const turns = yield* Ref.get(started);
        assert.deepEqual(
          turns.map((turn) => turn.cwd),
          [first, fresh, fresh],
        );
        // Only the first turn in the fresh checkout is told about it.
        const note = JSON.stringify(replacedWorkspaceNote(fresh, "fresh")).slice(1, -1);
        assert.deepEqual(
          turns.map((turn) => turn.input.includes(note)),
          [false, true, false],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it("repeats the fresh-checkout note until a provider has taken a prompt carrying it", () => {
  const replacedAt = DateTime.makeUnsafe("2026-10-19T12:00:00Z");
  const thread = { worktreePath: "/slipjay/workspaces/fresh", workspaceReplacedAt: replacedAt };
  const earlier = {
    id: RunAttemptId.make("attempt:earlier"),
    runId: RunId.make("run:earlier"),
    startedAt: DateTime.makeUnsafe("2026-10-19T12:01:00Z"),
  };
  const current = RunId.make("run:current");
  // The earlier run's provider refused before it received the prompt.
  assert.deepEqual(replacedWorkspace(thread, [earlier], [], current), {
    worktreePath: thread.worktreePath,
    outcome: "fresh",
  });
  assert.isNull(replacedWorkspace(thread, [earlier], [{ runAttemptId: earlier.id }], current));
});

it("reports a removed workspace that could not be replaced, once", () => {
  const replacedAt = DateTime.makeUnsafe("2026-10-19T12:00:00Z");
  const thread = { worktreePath: null, workspaceReplacedAt: replacedAt };
  const earlier = {
    id: RunAttemptId.make("attempt:earlier"),
    runId: RunId.make("run:earlier"),
    startedAt: DateTime.makeUnsafe("2026-10-19T12:01:00Z"),
  };
  const current = RunId.make("run:current");
  assert.deepEqual(replacedWorkspace(thread, [], [], current), {
    worktreePath: null,
    outcome: "fresh",
  });
  assert.isNull(replacedWorkspace(thread, [earlier], [{ runAttemptId: earlier.id }], current));
  assert.isNull(
    replacedWorkspace({ worktreePath: null, workspaceReplacedAt: null }, [], [], current),
  );
});

it("tells the turn why a removed workspace could not be replaced or take its Build item", () => {
  const replacedAt = DateTime.makeUnsafe("2026-10-19T12:00:00Z");
  const current = RunId.make("run:current");
  const unavailable = replacedWorkspace(
    {
      worktreePath: null,
      workspaceReplacedAt: replacedAt,
      workspaceReplacement: { outcome: "unavailable", detail: "the spare pool is empty" },
    },
    [],
    [],
    current,
  );
  assert.deepEqual(unavailable, {
    worktreePath: null,
    outcome: "fresh",
    detail: "the spare pool is empty",
  });
  assert.include(
    unreplacedWorkspaceNote("/project", unavailable?.detail),
    "the spare pool is empty",
  );
  // A thread left on the project checkout is told which Build item to attach to its workspace.
  assert.include(unreplacedWorkspaceNote("/project", undefined, 42), "slipjay attach-issue 42");
  assert.equal(
    replacedWorkspace(
      { worktreePath: null, workspaceReplacedAt: replacedAt, workspaceIssue: 42 },
      [],
      [],
      current,
    )?.forgeItem,
    42,
  );

  const fresh = replacedWorkspace(
    {
      worktreePath: "/slipjay/workspaces/fresh",
      workspaceReplacedAt: replacedAt,
      workspaceReplacement: { outcome: "fresh", detail: "Build item #42 is held elsewhere" },
    },
    [],
    [],
    current,
  );
  assert.include(
    replacedWorkspaceNote("/slipjay/workspaces/fresh", fresh!.outcome, fresh?.detail),
    "Build item #42 is held elsewhere",
  );
});

it("calls a replacement fresh only when SlipJay created it", () => {
  const replacedAt = DateTime.makeUnsafe("2026-10-19T12:00:00Z");
  const current = RunId.make("run:current");
  const noteFor = (outcome: OrchestrationV2ReplacedWorkspaceOutcome) => {
    const replaced = replacedWorkspace(
      {
        worktreePath: "/slipjay/workspaces/item-42",
        workspaceReplacedAt: replacedAt,
        workspaceReplacement: { outcome },
      },
      [],
      [],
      current,
    );
    assert.equal(replaced?.outcome, outcome);
    return replacedWorkspaceNote("/slipjay/workspaces/item-42", replaced!.outcome);
  };
  assert.include(noteFor("fresh"), "fresh checkout");
  const resumed = noteFor("resumed");
  assert.include(resumed, "resumed rather than created");
  assert.notInclude(resumed, "fresh checkout");
  const unconfirmed = noteFor("unconfirmed");
  assert.include(unconfirmed, "did not say whether it created");
  assert.notInclude(unconfirmed, "fresh checkout");
});
