import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AgentTaskBinding,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  EnvironmentId,
  ThreadId,
  NodeId,
  RunId,
  type OrchestrationV2RemoteTaskChild,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Advice from "./AdviceService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

const parentId = ThreadId.make("parent");
const workerId = ThreadId.make("worker");
const otherId = ThreadId.make("other");
const environmentId = EnvironmentId.make("here");
const scope = (threadId: ThreadId): McpInvocationScope => ({
  environmentId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: threadId,
  client: undefined,
  thread: {
    threadId,
    providerInstanceId: liveThreadShell(threadId).providerInstanceId,
    providerSessionId: `session:${threadId}`,
  },
  endpointKey: "reader",
  toolProfile: "source-reader",
  agentRole: "scout",
});
const question = {
  question: "Which shared contract?",
  evidence: "Callers disagree.",
  recommendation: "Preserve v1 until both migrate.",
  blocking: true,
};
const worker = (): OrchestrationV2ThreadShell => ({
  ...liveThreadShell(workerId),
  agentTask: {
    role: "scout",
    sourceAccess: "read-only",
    toolProfile: "source-reader",
  } as AgentTaskBinding,
  lineage: {
    rootThreadId: parentId,
    parentThreadId: parentId,
    relationshipToParent: "subagent" as const,
  },
});
const fixture = Effect.gen(function* () {
  const child = yield* Ref.make(worker());
  const taskStatus = yield* Ref.make("running");
  const remote = yield* Ref.make<OrchestrationV2RemoteTaskChild | undefined>(undefined);
  const cancelledRuns = new Set<string>();
  const messages = new Map<
    string,
    Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>
  >();
  const commands: OrchestrationV2ServerCommand[] = [];
  const threadsLayer = Layer.mock(Threads.ThreadManagementService)({
    getThreadShell: (id) =>
      id === workerId ? Ref.get(child) : Effect.succeed(liveThreadShell(id)),
    getThreadRecords: (id) =>
      Effect.gen(function* () {
        const shell = id === workerId ? yield* Ref.get(child) : liveThreadShell(id);
        const projection = idleThreadProjection(shell);
        return {
          ...projection,
          runs: [...messages.values()]
            .filter(
              (message) =>
                message.threadId === id && !cancelledRuns.has(`queue:${message.messageId}`),
            )
            .map(
              (message) =>
                ({
                  id: RunId.make(`queue:${message.messageId}`),
                  userMessageId: message.messageId,
                  status: "queued",
                }) as never,
            ),
          subagents:
            id === parentId
              ? [
                  {
                    id: NodeId.make("task"),
                    threadId: parentId,
                    childThreadId: workerId,
                    origin: "app_owned",
                    status: yield* Ref.get(taskStatus),
                    completionDelivery: { state: "pending" },
                    remoteChild: yield* Ref.get(remote),
                  } as never,
                ]
              : [],
        };
      }),
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        if (command.type === "queued-run.cancel") cancelledRuns.add(command.runId);
        if (command.type === "message.dispatch") messages.set(command.messageId, command);
        return { sequence: commands.length, storedEvents: [] };
      }),
    streamDomainEvents: Stream.empty,
    recoverDelegatedTask: () => Effect.void,
    delegatedTaskResultPending: () => Effect.succeed(false),
  });
  const layer = Advice.layer.pipe(
    Layer.provide(threadsLayer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(NodeServices.layer),
  );
  return { layer, threadsLayer, child, remote, cancelledRuns, taskStatus, messages, commands };
});

it.effect(
  "a read-only worker asks its actual parent, retries identically, and receives one durable answer",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* Advice.AdviceService;
        const first = yield* service.ask(scope(workerId), "shared-contract", question);
        expect(first).toMatchObject({
          parentThreadId: parentId,
          workerThreadId: workerId,
          status: "pending",
          delivery: "delivered",
        });
        expect(yield* service.ask(scope(workerId), "shared-contract", question)).toEqual(first);
        expect(f.messages.size).toBe(1);
        expect([...f.messages.values()][0]).toMatchObject({
          threadId: parentId,
          dispatchMode: { type: "queue_after_active" },
        });
        expect(
          yield* service.answer(scope(parentId), workerId, "shared-contract", "Keep v1."),
        ).toMatchObject({ status: "answered", answer: "Keep v1." });
        yield* service.answer(scope(parentId), workerId, "shared-contract", "Keep v1.");
        expect(f.messages.size).toBe(2);
        expect(yield* service.read(scope(workerId), workerId, "shared-contract")).toMatchObject({
          status: "answered",
          answer: "Keep v1.",
        });
        expect(yield* service.ask(scope(workerId), "shared-contract", question)).toMatchObject({
          status: "answered",
          answer: "Keep v1.",
        });
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect(
  "refuses conflicting retries, a second pending request, and unrelated readers or answers",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* Advice.AdviceService;
        yield* service.ask(scope(workerId), "one", question);
        for (const change of [
          { question: "Other?" },
          { evidence: "Other evidence" },
          { recommendation: "Other recommendation" },
          { blocking: false },
        ]) {
          expect(
            (yield* service
              .ask(scope(workerId), "one", { ...question, ...change })
              .pipe(Effect.flip)).code,
          ).toBe("invalid_request");
        }
        expect((yield* service.ask(scope(workerId), "two", question).pipe(Effect.flip)).code).toBe(
          "invalid_request",
        );
        expect(
          (yield* service.answer(scope(otherId), workerId, "one", "Yes").pipe(Effect.flip)).code,
        ).toBe("capability_denied");
        expect(
          (yield* service.answer(scope(workerId), workerId, "one", "Yes").pipe(Effect.flip)).code,
        ).toBe("capability_denied");
        expect((yield* service.read(scope(otherId), workerId, "one").pipe(Effect.flip)).code).toBe(
          "capability_denied",
        );
        yield* service.answer(scope(parentId), workerId, "one", "Keep v1.");
        expect(
          (yield* service.answer(scope(parentId), workerId, "one", "Change v2.").pipe(Effect.flip))
            .code,
        ).toBe("invalid_request");
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("requires a fresh explained follow-up to an answered consultation", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* Advice.AdviceService;
      yield* service.ask(scope(workerId), "one", question);
      yield* service.answer(scope(parentId), workerId, "one", "Keep v1.");
      expect(
        (yield* service
          .ask(scope(workerId), "two", { ...question, followsRequestId: "one" })
          .pipe(Effect.flip)).code,
      ).toBe("invalid_request");
      expect(
        (yield* service
          .ask(scope(workerId), "two", {
            ...question,
            followsRequestId: "missing",
            newEvidence: "New caller",
          })
          .pipe(Effect.flip)).code,
      ).toBe("invalid_request");
      expect(
        yield* service.ask(scope(workerId), "two", {
          ...question,
          followsRequestId: "one",
          newEvidence: "A shipped caller rejects v1.",
        }),
      ).toMatchObject({ status: "pending", followsRequestId: "one" });
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("cancellation and ended ownership refuse late answers without resurrecting work", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* Advice.AdviceService;
      yield* service.ask(scope(workerId), "one", question);
      yield* service.cancel(scope(workerId), workerId, "one");
      expect(f.cancelledRuns.size).toBe(1);
      expect(
        (yield* service.answer(scope(parentId), workerId, "one", "Late").pipe(Effect.flip)).code,
      ).toBe("invalid_request");
      expect(yield* service.ask(scope(workerId), "one", question)).toMatchObject({
        status: "cancelled",
      });
      yield* service.ask(scope(workerId), "two", question);
      yield* Ref.set(f.taskStatus, "cancelled");
      yield* service.recover();
      expect(yield* service.read(scope(workerId), workerId, "two")).toMatchObject({
        status: "cancelled",
      });
      expect(f.messages.size).toBe(2);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("a managed top-level thread has no parent and dispatches nothing", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Ref.update(f.child, (thread) => ({
      ...thread,
      lineage: { rootThreadId: workerId, parentThreadId: null, relationshipToParent: null },
    }));
    yield* Effect.gen(function* () {
      const service = yield* Advice.AdviceService;
      expect((yield* service.ask(scope(workerId), "one", question).pipe(Effect.flip)).code).toBe(
        "no_parent",
      );
      expect(f.messages.size).toBe(0);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect(
  "linked advice stays durable before delivery and only its originating peer can answer",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Ref.update(f.child, (thread) => ({
        ...thread,
        lineage: { rootThreadId: workerId, parentThreadId: null, relationshipToParent: null },
        delegatedFrom: {
          threadId: parentId,
          environmentId: EnvironmentId.make("there"),
          title: "Parent",
        },
        linkOrigin: { sessionId: "peer-session", label: "Peer", access: "read-only" as const },
      }));
      const peer: McpInvocationScope = {
        ...scope(parentId),
        thread: undefined,
        client: { sessionId: "peer-session", label: "Peer", linked: true, access: "read-only" },
      };
      yield* Effect.gen(function* () {
        const service = yield* Advice.AdviceService;
        const channel = yield* service
          .waitPeer(peer, workerId, parentId, "")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        expect(yield* service.ask(scope(workerId), "remote", question)).toMatchObject({
          status: "pending",
        });
        yield* Fiber.join(channel);
        expect(yield* service.read(scope(workerId), workerId, "remote")).toMatchObject({
          status: "pending",
          delivery: "unavailable",
        });
        expect(yield* service.ask(scope(workerId), "remote", question)).toMatchObject({
          status: "pending",
          delivery: "unavailable",
        });
        expect(f.messages.size).toBe(0);
        expect(yield* service.peerRead(peer, workerId, parentId)).toHaveLength(1);
        expect(
          (yield* service
            .peerRead(
              { ...peer, client: { ...peer.client!, sessionId: "unrelated" } },
              workerId,
              parentId,
            )
            .pipe(Effect.flip)).code,
        ).toBe("capability_denied");
        expect((yield* service.peerRead(peer, workerId, otherId).pipe(Effect.flip)).code).toBe(
          "capability_denied",
        );
        expect(
          (yield* service.answer(scope(parentId), workerId, "remote", "Forged").pipe(Effect.flip))
            .code,
        ).toBe("capability_denied");
        const disconnected = yield* service
          .waitPeer(peer, workerId, parentId)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Fiber.interrupt(disconnected);
        expect(yield* service.read(scope(workerId), workerId, "remote")).toMatchObject({
          status: "pending",
          delivery: "unavailable",
          answer: null,
        });
        const waiter = yield* service
          .waitPeer(peer, workerId, parentId)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* service.answer(peer, workerId, "remote", "Keep v1.", parentId);
        expect(yield* Fiber.join(waiter)).toMatchObject([
          { status: "answered", answer: "Keep v1." },
        ]);
        yield* service.recover();
        expect(f.messages.size).toBe(1);
        expect(yield* service.read(scope(workerId), workerId, "remote")).toMatchObject({
          status: "answered",
          answer: "Keep v1.",
        });
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("rebuilding the service replays accepted requests and answers from durable storage", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const layer = Advice.layer.pipe(Layer.provide(f.threadsLayer));
    yield* Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* (yield* Advice.AdviceService).ask(scope(workerId), "survives-restart", question);
      }).pipe(Effect.provide(Layer.fresh(layer)));
      yield* Effect.gen(function* () {
        const service = yield* Advice.AdviceService;
        yield* service.recover();
        expect(yield* service.ask(scope(workerId), "survives-restart", question)).toMatchObject({
          status: "pending",
        });
        yield* service.answer(scope(parentId), workerId, "survives-restart", "Keep v1.");
      }).pipe(Effect.provide(Layer.fresh(layer)));
      yield* Effect.gen(function* () {
        const service = yield* Advice.AdviceService;
        yield* service.recover();
        expect(yield* service.ask(scope(workerId), "survives-restart", question)).toMatchObject({
          status: "answered",
          answer: "Keep v1.",
        });
        expect(f.messages.size).toBe(2);
      }).pipe(Effect.provide(Layer.fresh(layer)));
    }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer))));
  }),
);

it.effect(
  "a parent retains accepted remote advice across disconnection and deduplicates reconnect delivery",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const there = EnvironmentId.make("there");
      yield* Ref.set(f.remote, {
        environmentId: there,
        threadId: workerId,
        label: "Peer",
      } as OrchestrationV2RemoteTaskChild);
      yield* Effect.gen(function* () {
        const service = yield* Advice.AdviceService;
        const request = {
          ...question,
          workerThreadId: workerId,
          parentThreadId: parentId,
          requestId: "linked",
          status: "pending" as const,
          answer: null,
          delivery: "pending" as const,
        };
        yield* service.receiveRemote(there, request);
        expect(f.messages.size).toBe(1);
        expect(
          (yield* service
            .answer(scope(parentId), workerId, "linked", "Local-only answer")
            .pipe(Effect.flip)).code,
        ).toBe("invalid_request");
        expect(
          (yield* service.cancel(scope(parentId), workerId, "linked").pipe(Effect.flip)).code,
        ).toBe("invalid_request");
        yield* service.remoteUnavailable(workerId);
        expect(yield* service.read(scope(parentId), workerId, "linked")).toMatchObject({
          status: "pending",
          delivery: "unavailable",
          answer: null,
        });
        yield* service.receiveRemote(there, request);
        expect(f.messages.size).toBe(1);
        yield* service.receiveRemote(there, { ...request, status: "answered", answer: "Keep v1." });
        expect(yield* service.read(scope(parentId), workerId, "linked")).toMatchObject({
          status: "answered",
          answer: "Keep v1.",
        });
        expect(f.cancelledRuns.size).toBe(1);
        expect(f.messages.size).toBe(1);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect(
  "consultation identities cover destination changes and reserve one pending request per thread",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* Advice.AdviceService;
        const input = { action: "ask" as const, clientRequestId: "same", ...question };
        yield* service.reserve(scope(workerId), input);
        yield* service.reserve(scope(workerId), input);
        expect(
          (yield* service
            .reserve(scope(workerId), {
              ...input,
              destination: "advisor",
              advisor: { workId: "work", workspacePath: "/source", sourceRevision: "revision" },
            })
            .pipe(Effect.flip)).code,
        ).toBe("invalid_request");
        expect(
          (yield* service
            .reserve(scope(workerId), { ...input, clientRequestId: "other" })
            .pipe(Effect.flip)).code,
        ).toBe("invalid_request");
        yield* service.ask(scope(workerId), "same", question);
        yield* service.answer(scope(parentId), workerId, "same", "Keep v1.");
        yield* service.reserve(scope(workerId), {
          ...input,
          clientRequestId: "next",
          followsRequestId: "same",
          newEvidence: "A shipped caller rejects v1.",
        });
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect(
  "a linked worker recovers one request and answer when its service restarts while disconnected",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Ref.update(f.child, (thread) => ({
        ...thread,
        delegatedFrom: {
          threadId: parentId,
          environmentId: EnvironmentId.make("there"),
          title: "Parent",
        },
        linkOrigin: { sessionId: "peer-session", label: "Peer", access: "read-only" as const },
      }));
      const peer: McpInvocationScope = {
        ...scope(parentId),
        thread: undefined,
        client: { sessionId: "peer-session", label: "Peer", linked: true, access: "read-only" },
      };
      const layer = Advice.layer.pipe(Layer.provide(f.threadsLayer));
      yield* Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const service = yield* Advice.AdviceService;
          const channel = yield* service
            .waitPeer(peer, workerId, parentId, "")
            .pipe(Effect.forkScoped({ startImmediately: true }));
          expect(yield* service.ask(scope(workerId), "linked-restart", question)).toMatchObject({
            status: "pending",
          });
          yield* Fiber.join(channel);
        }).pipe(Effect.provide(Layer.fresh(layer)));
        yield* Effect.gen(function* () {
          const service = yield* Advice.AdviceService;
          yield* service.recover();
          expect(yield* service.peerRead(peer, workerId, parentId)).toMatchObject([
            { requestId: "linked-restart", status: "pending", answer: null },
          ]);
          expect(f.messages.size).toBe(0);
          yield* service.delivered(workerId, "linked-restart");
          yield* service.answer(peer, workerId, "linked-restart", "Keep v1.", parentId);
        }).pipe(Effect.provide(Layer.fresh(layer)));
        yield* Effect.gen(function* () {
          const service = yield* Advice.AdviceService;
          yield* service.recover();
          yield* service.answer(peer, workerId, "linked-restart", "Keep v1.", parentId);
          expect(yield* service.ask(scope(workerId), "linked-restart", question)).toMatchObject({
            status: "answered",
            answer: "Keep v1.",
          });
          expect(f.messages.size).toBe(1);
        }).pipe(Effect.provide(Layer.fresh(layer)));
      }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer))));
    }),
);

it.effect(
  "a completed delegation cancels pending nonblocking advice and refuses a late answer",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* Advice.AdviceService;
        yield* service.ask(scope(workerId), "ended", { ...question, blocking: false });
        yield* Ref.set(f.taskStatus, "completed");
        yield* service.recover();
        expect(yield* service.read(scope(workerId), workerId, "ended")).toMatchObject({
          status: "cancelled",
        });
        expect(
          (yield* service.answer(scope(parentId), workerId, "ended", "Late").pipe(Effect.flip))
            .code,
        ).toBe("capability_denied");
        expect(f.messages.size).toBe(1);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect(
  "a linked worker refuses an unaccepted consultation while its parent delivery channel is unavailable",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Ref.update(f.child, (thread) => ({
        ...thread,
        delegatedFrom: {
          threadId: parentId,
          environmentId: EnvironmentId.make("there"),
          title: "Parent",
        },
        linkOrigin: { sessionId: "peer-session", label: "Peer", access: "read-only" as const },
      }));
      yield* Effect.gen(function* () {
        const service = yield* Advice.AdviceService;
        expect(
          (yield* service.ask(scope(workerId), "offline", question).pipe(Effect.flip)).code,
        ).toBe("provider_unavailable");
        expect(yield* service.pending(workerId)).toBeUndefined();
        const peer: McpInvocationScope = {
          ...scope(parentId),
          thread: undefined,
          client: { sessionId: "peer-session", label: "Peer", linked: true, access: "read-only" },
        };
        const channel = yield* service
          .waitPeer(peer, workerId, parentId, "")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        expect(yield* service.ask(scope(workerId), "offline", question)).toMatchObject({
          requestId: "offline",
          status: "pending",
        });
        yield* Fiber.join(channel);
        expect(yield* service.read(scope(workerId), workerId, "offline")).toMatchObject({
          status: "pending",
          delivery: "unavailable",
        });
      }).pipe(Effect.provide(f.layer));
    }),
);
