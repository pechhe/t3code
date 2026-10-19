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

const projectId = ProjectId.make("project-hq");
const lead = ThreadId.make("thread-lead");
const reviewer = ThreadId.make("thread-reviewer");
const rawChild = ThreadId.make("thread-raw-child");

const withReactor = <A, E>(
  body: (input: {
    readonly reactor: HqAgentLifecycleReactor.HqAgentLifecycleReactor["Service"];
    readonly calls: Array<{ readonly kind: "end" | "forget"; readonly agent: unknown }>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const calls: Array<{ readonly kind: "end" | "forget"; readonly agent: unknown }> = [];
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
                end: (agent) => Effect.sync(() => void calls.push({ kind: "end", agent })),
                forget: (agent) => Effect.sync(() => void calls.push({ kind: "forget", agent })),
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
  ({ type: "run.updated", threadId, payload }) as unknown as OrchestrationV2DomainEvent;
const threadEvent = (type: "thread.archived" | "thread.deleted", threadId: ThreadId) =>
  ({ type, threadId, payload: {} }) as unknown as OrchestrationV2DomainEvent;

it.effect("a delegated task that completes, fails or is cancelled ends its agent", () =>
  withReactor(({ reactor, calls }) =>
    Effect.gen(function* () {
      for (const status of ["completed", "failed", "cancelled"] as const)
        yield* reactor.handle(
          runUpdated(reviewer, { status, delegatedTaskId: "node-task" as never }),
        );
      assert.deepStrictEqual(
        calls,
        Array.from({ length: 3 }, () => ({
          kind: "end",
          agent: { threadId: reviewer, role: "spec-reviewer" },
        })),
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

it.effect("archiving ends a lead's agent and deleting also drops its connection", () =>
  withReactor(({ reactor, calls }) =>
    Effect.gen(function* () {
      yield* reactor.handle(threadEvent("thread.archived", lead));
      yield* reactor.handle(threadEvent("thread.deleted", lead));
      const agent = { threadId: lead, role: "lead" };
      assert.deepStrictEqual(calls, [
        { kind: "end", agent },
        { kind: "forget", agent },
      ]);
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
