import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";
import * as HqAgentLifecycleReactor from "./HqAgentLifecycleReactor.ts";
import * as HqForgeRecords from "./HqForgeRecords.ts";
import * as HqForgeRecordingReactor from "./HqForgeRecordingReactor.ts";

const projectId = ProjectId.make("project-hq");
const lead = ThreadId.make("thread-lead");
const reviewer = ThreadId.make("thread-reviewer");
const rawChild = ThreadId.make("thread-raw-child");

const withReactor = <A, E>(
  body: (input: {
    readonly reactor: HqAgentLifecycleReactor.HqAgentLifecycleReactor["Service"];
    readonly calls: Array<{ readonly kind: "end" | "forget" | "records"; readonly agent: unknown }>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const calls: Array<{
      readonly kind: "end" | "forget" | "records";
      readonly agent: unknown;
    }> = [];
    const reactor = yield* Effect.service(HqAgentLifecycleReactor.HqAgentLifecycleReactor).pipe(
      Effect.provide(
        HqAgentLifecycleReactor.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Orchestrator.OrchestratorV2)({}),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThread: (threadId: ThreadId) =>
                  Effect.succeed({
                    id: threadId,
                    projectId,
                    lineage: { parentThreadId: threadId === lead ? null : lead },
                    ...(threadId === reviewer ? { agentTask: { role: "spec-reviewer" } } : {}),
                  } as never),
              }),
              Layer.mock(HqAgentConnections.HqAgentConnections)({
                forget: (agent) => Effect.sync(() => void calls.push({ kind: "forget", agent })),
              }),
              Layer.mock(HqForgeRecords.HqForgeRecords)({
                enqueue: (record) =>
                  Effect.sync(
                    () =>
                      void calls.push({
                        kind: "end",
                        agent: { ...record },
                      }),
                  ),
                forgetThread: () => Effect.void,
              }),
              Layer.mock(HqForgeRecordingReactor.HqForgeRecordingReactor)({
                recordCompletion: (threadId) =>
                  Effect.sync(() => void calls.push({ kind: "records", agent: threadId })),
              }),
            ),
          ),
        ),
      ),
    );
    return yield* body({ reactor, calls });
  });

const runUpdated = (
  threadId: ThreadId,
  payload: Partial<OrchestrationV2Run>,
): OrchestrationV2DomainEvent =>
  ({
    type: "run.updated",
    threadId,
    payload: { id: "run-1", ...payload },
  }) as unknown as OrchestrationV2DomainEvent;
const threadEvent = (type: "thread.archived" | "thread.deleted", threadId: ThreadId) =>
  ({ type, threadId, payload: {} }) as unknown as OrchestrationV2DomainEvent;

it.effect("a delegated task that completes, fails or is cancelled queues its agent's end", () =>
  withReactor(({ reactor, calls }) =>
    Effect.gen(function* () {
      for (const status of ["completed", "failed", "cancelled"] as const)
        yield* reactor.handle(
          runUpdated(reviewer, { status, delegatedTaskId: "node-task" as never }),
        );
      // Queued rather than ended: the queue sends it once the thread's Forge records have gone.
      assert.deepStrictEqual(
        calls.map((call) => call.kind),
        ["records", "end", "records", "end", "records", "end"],
      );
      for (const call of calls.filter((call) => call.kind === "end")) {
        const record = call.agent as { threadId: string; kind: string; role: string };
        assert.strictEqual(record.kind, "end");
        assert.strictEqual(record.threadId, reviewer);
        assert.strictEqual(record.role, "spec-reviewer");
      }
    }),
  ),
);

it.effect("what a finished run recorded is queued before its agent's end", () =>
  withReactor(({ reactor, calls }) =>
    Effect.gen(function* () {
      yield* reactor.handle(
        runUpdated(reviewer, { status: "completed", delegatedTaskId: "node-task" as never }),
      );
      // Both in one fiber, in this order: an end may not overtake the records it must not outlive.
      assert.deepStrictEqual(
        calls.map((call) => call.kind),
        ["records", "end"],
      );
      assert.deepStrictEqual(
        calls.map((call) => call.agent),
        [
          reviewer,
          {
            kind: "end",
            recordKey: "end:thread-reviewer:run-1",
            threadId: reviewer,
            role: "spec-reviewer",
          },
        ],
      );
    }),
  ),
);

it.effect("an interrupted task or a lead's finished turn keeps its agent", () =>
  withReactor(({ reactor, calls }) =>
    Effect.gen(function* () {
      yield* reactor.handle(
        runUpdated(reviewer, { status: "interrupted", delegatedTaskId: "node-task" as never }),
      );
      yield* reactor.handle(runUpdated(lead, { status: "completed" }));
      assert.deepStrictEqual(calls, []);
    }),
  ),
);

it.effect("archiving keeps a lead's agent and deleting drops its connection", () =>
  withReactor(({ reactor, calls }) =>
    Effect.gen(function* () {
      yield* reactor.handle(threadEvent("thread.archived", lead));
      assert.deepStrictEqual(calls, []);
      yield* reactor.handle(threadEvent("thread.deleted", lead));
      assert.deepStrictEqual(calls, [{ kind: "forget", agent: { threadId: lead, role: "lead" } }]);
    }),
  ),
);

it.effect("a raw delegated child never had an HQ agent, so nothing is ended", () =>
  withReactor(({ reactor, calls }) =>
    Effect.gen(function* () {
      yield* reactor.handle(
        runUpdated(rawChild, { status: "completed", delegatedTaskId: "node-task" as never }),
      );
      yield* reactor.handle(threadEvent("thread.archived", rawChild));
      yield* reactor.handle(threadEvent("thread.deleted", rawChild));
      assert.deepStrictEqual(calls, []);
    }),
  ),
);
