import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  RunId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ForgeSpecOfThread from "./ForgeSpecOfThread.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";
import type { FakeHq } from "./HqAgentConnections.testkit.ts";
import { makeHqHarness, origin } from "./HqAgentConnections.testkit.ts";
import * as HqForgeRecords from "./HqForgeRecords.ts";
import * as HqForgeRecordingReactor from "./HqForgeRecordingReactor.ts";

const projectId = ProjectId.make("project-hq");
const lead = ThreadId.make("thread-lead");
const child = ThreadId.make("thread-child");
const grandchild = ThreadId.make("thread-grandchild");
const reviewer = ThreadId.make("thread-reviewer");
const silentReviewer = ThreadId.make("thread-reviewer-silent");
const unlinked = ThreadId.make("thread-unlinked");
const model = "claude-opus-5-5";
const worktreePath = "/workspace/t3";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const startedAt = "2026-10-01T10:00:00.000Z";
const endedAt = "2026-10-01T10:30:00.000Z";

const threadOf = (
  id: ThreadId,
  overrides: Record<string, unknown> = {},
): OrchestrationV2AppThread =>
  ({
    id,
    projectId,
    title: `Thread ${id}`,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    modelSelection: { model },
    worktreePath,
    branch: null,
    ...overrides,
  }) as unknown as OrchestrationV2AppThread;

const childOf = (id: ThreadId, parent: ThreadId, role: string, overrides = {}) =>
  threadOf(id, {
    lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: lead },
    agentTask: { role, workId: `work-${id}` },
    ...overrides,
  });

/** The subagent record a delegate_task child leaves: its times are what a helper reports. */
const subagentOf = (
  childThreadId: ThreadId,
  overrides: Record<string, unknown> = {},
): OrchestrationV2Subagent =>
  ({
    id: `node-${childThreadId}`,
    threadId: lead,
    runId: null,
    parentNodeId: "node-parent",
    origin: "app_owned",
    childThreadId,
    prompt: "Do the work",
    title: "Implement package B",
    model,
    status: "completed",
    result: null,
    startedAt: at(startedAt),
    completedAt: at(endedAt),
    updatedAt: at(endedAt),
    ...overrides,
  }) as unknown as OrchestrationV2Subagent;

const finishedRunOf = (
  threadId: ThreadId,
  {
    id = "run-1",
    model: runModel = model,
    startedAt: runStartedAt = at(startedAt),
    completedAt: runCompletedAt = at(endedAt),
  } = {},
): OrchestrationV2Run =>
  ({
    id: RunId.make(id),
    threadId,
    modelSelection: { model: runModel },
    status: "completed",
    delegatedTaskId: "node-task",
    startedAt: runStartedAt,
    completedAt: runCompletedAt,
  }) as unknown as OrchestrationV2Run;

const threadEvent = (
  type: "thread.created" | "thread.metadata-updated",
  payload: OrchestrationV2AppThread,
): OrchestrationV2DomainEvent =>
  ({ type, threadId: payload.id, payload }) as unknown as OrchestrationV2DomainEvent;

const ofKind = <K extends HqForgeRecords.HqForgeRecordKind>(
  records: ReadonlyArray<HqForgeRecords.HqForgeRecordInput>,
  kind: K,
): ReadonlyArray<Extract<HqForgeRecords.HqForgeRecordInput, { kind: K }>> =>
  records.filter(
    (record): record is Extract<HqForgeRecords.HqForgeRecordInput, { kind: K }> =>
      record.kind === kind,
  );

interface State {
  readonly threads: Map<ThreadId, OrchestrationV2AppThread>;
  readonly subagents: Map<ThreadId, OrchestrationV2Subagent>;
  readonly reviewerRuns: Array<HqForgeRecords.HqForgeReviewerRun>;
  readonly items: Map<
    string,
    { readonly id?: string; readonly kind: string; readonly parentId: string | null }
  >;
  readonly project: ProjectStore.ProjectRow;
}

/**
 * The reactor over Weave's fake and a projection that says what each thread is, so a test drives
 * the behaviour it owns: which records a link and a finished delegated run queue.
 */
const withReactor = <A, E>(
  body: (input: {
    readonly reactor: HqForgeRecordingReactor.HqForgeRecordingReactor["Service"];
    readonly enqueued: ReadonlyArray<HqForgeRecords.HqForgeRecordInput>;
    readonly hq: FakeHq;
    readonly state: State;
    /** Every Forge item read, in order, so a test can see a Ticket is read once. */
    readonly reads: ReadonlyArray<string>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const { hq, connections } = yield* makeHqHarness;
    const enqueued: Array<HqForgeRecords.HqForgeRecordInput> = [];
    const reads: Array<string> = [];
    const state: State = {
      threads: new Map(),
      subagents: new Map(),
      reviewerRuns: [],
      items: new Map(),
      project: {
        projectId,
        title: "T3",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        hqRepositoryKey: "pechhe/t3code",
        scripts: [],
        createdAt: startedAt,
        updatedAt: startedAt,
        deletedAt: null,
      } as unknown as ProjectStore.ProjectRow,
    };
    hq.tools.call = (name, args) => {
      if (name !== "hq_forge_read") return { status: "failed", code: "unknown_tool" };
      // A workspace's item is read by its number, which no link carries.
      const itemId = args.itemId === undefined ? `number:${args.number}` : String(args.itemId);
      reads.push(itemId);
      const item = state.items.get(itemId);
      return item === undefined
        ? { status: "failed", code: "build_item_unavailable" }
        : { status: "succeeded", value: { id: itemId, ...item } };
    };
    const reactor = yield* Effect.service(HqForgeRecordingReactor.HqForgeRecordingReactor).pipe(
      Effect.provide(
        HqForgeRecordingReactor.layer.pipe(
          Layer.provide(ForgeSpecOfThread.layer),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Orchestrator.OrchestratorV2)({}),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThread: (threadId: ThreadId) => {
                  const thread = state.threads.get(threadId);
                  return thread === undefined
                    ? Effect.fail(
                        new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }),
                      )
                    : Effect.succeed(thread);
                },
                getSubagentByChildThread: (childThreadId: ThreadId) =>
                  Effect.succeed(state.subagents.get(childThreadId)),
              }),
              Layer.mock(ProjectStore.ProjectStoreV2)({
                get: () => Effect.succeed(Option.some(state.project)),
              }),
              Layer.succeed(
                ServerEnvironment.ServerEnvironment,
                ServerEnvironment.ServerEnvironment.of({
                  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-hq")),
                  getDescriptor: Effect.succeed({ label: "agent-host" }),
                } as never),
              ),
              Layer.succeed(HqAgentConnections.HqAgentConnections, connections),
              Layer.mock(HqForgeRecords.HqForgeRecords)({
                enqueue: (record) => Effect.sync(() => void enqueued.push(record)),
                reviewerRuns: Effect.sync(() => state.reviewerRuns),
              }),
            ),
          ),
        ),
      ),
    );
    return yield* body({ reactor, enqueued, hq, state, reads });
  });

it.effect("a root thread that links a Forge item queues its session, and the same link once", () =>
  withReactor(({ reactor, enqueued, state }) =>
    Effect.gen(function* () {
      state.items.set("spec-1", { kind: "spec", parentId: null });
      const thread = threadOf(lead, {
        workItem: { itemId: "spec-1", number: 1, origin },
      });
      state.threads.set(lead, thread);

      yield* reactor.handle(threadEvent("thread.created", thread));
      // A metadata update carries the link again, as any later edit of the thread does.
      yield* reactor.handle(threadEvent("thread.metadata-updated", thread));

      const sessions = ofKind(enqueued, "session");
      assert.lengthOf(sessions, 2);
      // The same record key both times, which is what leaves one row in the queue.
      assert.deepStrictEqual(
        sessions.map((session) => session.recordKey),
        ["session:thread-lead:spec-1", "session:thread-lead:spec-1"],
      );
      assert.deepStrictEqual(sessions[0]!.bind, { specId: "spec-1" });
      assert.deepStrictEqual(sessions[0]!.startSession, {
        specId: "spec-1",
        harness: "t3code",
        sessionRef: "thread-lead",
        modelRef: model,
        workspaces: [
          { repository: "pechhe/t3code", host: "agent-host", workspaceRef: worktreePath },
        ],
      });
    }),
  ),
);

it.effect("a root thread whose workspace is attached to a Forge item queues its session", () =>
  withReactor(({ reactor, enqueued, state }) =>
    Effect.gen(function* () {
      state.items.set("number:7", { id: "spec-7", kind: "spec", parentId: null });
      const thread = threadOf(lead, { workspaceIssue: 7 });
      state.threads.set(lead, thread);

      yield* reactor.handle(threadEvent("thread.created", thread));

      const [session] = ofKind(enqueued, "session");
      assert.strictEqual(session?.recordKey, "session:thread-lead:#7");
      assert.strictEqual(session?.specId, "spec-7");
      assert.deepStrictEqual(session?.bind, { specId: "spec-7" });
    }),
  ),
);

it.effect("a workspace item in a project Forge does not track records nothing", () =>
  withReactor(({ reactor, enqueued, state, reads }) =>
    Effect.gen(function* () {
      Object.assign(state.project, { hqRepositoryKey: null });
      const thread = threadOf(lead, { workspaceIssue: 7 });
      state.threads.set(lead, thread);

      yield* reactor.handle(threadEvent("thread.created", thread));

      assert.lengthOf(enqueued, 0);
      assert.lengthOf(reads, 0);
    }),
  ),
);

it.effect("a link in a project with no repository still queues its session", () =>
  withReactor(({ reactor, enqueued, state }) =>
    Effect.gen(function* () {
      Object.assign(state.project, { hqRepositoryKey: null });
      const thread = threadOf(lead, { workItem: { itemId: "spec-1", number: 1, origin } });
      state.threads.set(lead, thread);

      // Weave cannot answer for the item yet, so its repository is not known to name.
      yield* reactor.handle(threadEvent("thread.created", thread));

      const [session] = ofKind(enqueued, "session");
      assert.deepStrictEqual(session?.startSession.workspaces, [
        { repository: null, host: "agent-host", workspaceRef: worktreePath },
      ]);
    }),
  ),
);

it.effect("a Ticket link resolves to the Spec the Ticket belongs to", () =>
  withReactor(({ reactor, enqueued, state, reads }) =>
    Effect.gen(function* () {
      state.items.set("ticket-9", { kind: "ticket", parentId: "spec-4" });
      const thread = threadOf(lead, {
        workItem: { itemId: "ticket-9", number: 9, origin },
      });
      state.threads.set(lead, thread);

      yield* reactor.handle(threadEvent("thread.created", thread));
      yield* reactor.handle(threadEvent("thread.metadata-updated", thread));

      const sessions = ofKind(enqueued, "session");
      assert.deepStrictEqual(
        sessions.map((session) => [session.recordKey, session.specId]),
        [
          ["session:thread-lead:ticket-9", "spec-4"],
          ["session:thread-lead:ticket-9", "spec-4"],
        ],
      );
      assert.deepStrictEqual(sessions[0]!.bind, { specId: "spec-4" });
      // The Ticket's Spec is read once, however often the link arrives.
      assert.deepStrictEqual(reads, ["ticket-9"]);
    }),
  ),
);

it.effect("a nested delegate_task child queues a helper under the same lead", () =>
  withReactor(({ reactor, enqueued, state }) =>
    Effect.gen(function* () {
      state.items.set("spec-1", { kind: "spec", parentId: null });
      state.threads.set(
        lead,
        threadOf(lead, { workItem: { itemId: "spec-1", number: 1, origin } }),
      );
      state.threads.set(child, childOf(child, lead, "implementation-worker"));
      state.threads.set(
        grandchild,
        childOf(grandchild, child, "implementation-worker", {
          modelSelection: { model: "gpt-5.5" },
        }),
      );
      state.subagents.set(grandchild, subagentOf(grandchild, { title: "Nested work" }));

      yield* reactor.recordCompletion(grandchild, finishedRunOf(grandchild, { model: "gpt-5.5" }));

      const helpers = ofKind(enqueued, "helper");
      assert.lengthOf(helpers, 1);
      const [helper] = helpers;
      assert.strictEqual(helper!.recordKey, "helper:thread-grandchild:run-1");
      // The work counts under the root thread that holds the link, at any depth.
      assert.strictEqual(helper!.leadThreadId, lead);
      assert.strictEqual(helper!.specId, "spec-1");
      assert.deepStrictEqual(helper!.args, {
        harness: "t3code",
        sessionRef: "t3:environment-hq/thread-grandchild/run-1",
        modelRef: "gpt-5.5",
        scope: "Nested work",
        startedAt,
        endedAt,
        transcriptRef: "t3-thread://v1/thread-grandchild",
      });
      assert.lengthOf(ofKind(enqueued, "runtimes"), 0);
    }),
  ),
);

it.effect("a child that carries a copy of its lead's link still names the lead as its lead", () =>
  withReactor(({ reactor, enqueued, state }) =>
    Effect.gen(function* () {
      state.items.set("spec-1", { kind: "spec", parentId: null });
      const link = { workItem: { itemId: "spec-1", number: 1, origin } };
      state.threads.set(lead, threadOf(lead, link));
      state.threads.set(child, childOf(child, lead, "implementation-worker", link));
      state.subagents.set(child, subagentOf(child, { title: "Copied link" }));

      yield* reactor.recordCompletion(child, finishedRunOf(child));

      const [helper] = ofKind(enqueued, "helper");
      assert.strictEqual(helper?.leadThreadId, lead);
    }),
  ),
);

it.effect("a reviewer child queues its own run times and is never a helper", () =>
  withReactor(({ reactor, enqueued, state }) =>
    Effect.gen(function* () {
      state.items.set("spec-1", { kind: "spec", parentId: null });
      state.threads.set(
        lead,
        threadOf(lead, { workItem: { itemId: "spec-1", number: 1, origin } }),
      );
      state.threads.set(reviewer, childOf(reviewer, lead, "spec-reviewer"));
      state.subagents.set(reviewer, subagentOf(reviewer, { title: "Review package B" }));
      state.reviewerRuns.push({
        reviewerThreadId: reviewer,
        runId: "run-7",
        t3RunId: "run-1",
        specId: "spec-1",
        createdAt: 1,
      });

      yield* reactor.recordCompletion(reviewer, finishedRunOf(reviewer));

      const runtimes = ofKind(enqueued, "runtimes");
      assert.lengthOf(runtimes, 1);
      assert.strictEqual(runtimes[0]!.recordKey, "runtimes:thread-reviewer:run-7");
      assert.deepStrictEqual(runtimes[0]!.args, { runId: "run-7", startedAt, endedAt });
      assert.lengthOf(ofKind(enqueued, "helper"), 0);
    }),
  ),
);

it.effect("a reviewer round that reported no run does not borrow an earlier round's run", () =>
  withReactor(({ reactor, enqueued, state }) =>
    Effect.gen(function* () {
      state.items.set("spec-1", { kind: "spec", parentId: null });
      state.threads.set(
        lead,
        threadOf(lead, { workItem: { itemId: "spec-1", number: 1, origin } }),
      );
      state.threads.set(reviewer, childOf(reviewer, lead, "spec-reviewer"));
      state.subagents.set(reviewer, subagentOf(reviewer, { title: "Review package B" }));
      state.reviewerRuns.push({
        reviewerThreadId: reviewer,
        runId: "run-7",
        t3RunId: "run-1",
        specId: "spec-1",
        createdAt: 1,
      });

      yield* reactor.recordCompletion(reviewer, finishedRunOf(reviewer, { id: "run-2" }));

      assert.lengthOf(ofKind(enqueued, "runtimes"), 0);
    }),
  ),
);

it.effect("a reviewer that has reported no run records nothing rather than guessing", () =>
  withReactor(({ reactor, enqueued, state }) =>
    Effect.gen(function* () {
      state.items.set("spec-1", { kind: "spec", parentId: null });
      state.threads.set(
        lead,
        threadOf(lead, { workItem: { itemId: "spec-1", number: 1, origin } }),
      );
      state.threads.set(silentReviewer, childOf(silentReviewer, lead, "spec-reviewer"));
      state.subagents.set(silentReviewer, subagentOf(silentReviewer));

      yield* reactor.recordCompletion(silentReviewer, finishedRunOf(silentReviewer));

      assert.deepStrictEqual(enqueued, []);
    }),
  ),
);

it.effect("a thread with no linked ancestor has nothing recorded", () =>
  withReactor(({ reactor, enqueued, state }) =>
    Effect.gen(function* () {
      state.threads.set(unlinked, threadOf(unlinked));
      state.subagents.set(unlinked, subagentOf(unlinked));

      yield* reactor.recordCompletion(unlinked, finishedRunOf(unlinked));
      // A thread that links no Forge item opens no session either.
      yield* reactor.handle(threadEvent("thread.created", threadOf(unlinked)));

      assert.deepStrictEqual(enqueued, []);
    }),
  ),
);

it.effect("two runs of one child queue a helper record each, under that run's own model", () =>
  withReactor(({ reactor, enqueued, state }) =>
    Effect.gen(function* () {
      state.items.set("spec-1", { kind: "spec", parentId: null });
      state.threads.set(
        lead,
        threadOf(lead, { workItem: { itemId: "spec-1", number: 1, origin } }),
      );
      state.threads.set(child, childOf(child, lead, "implementation-worker"));
      state.subagents.set(child, subagentOf(child));

      yield* reactor.recordCompletion(child, finishedRunOf(child));
      // A follow-up run, under another model, is its own record rather than a duplicate.
      yield* reactor.recordCompletion(
        child,
        finishedRunOf(child, { id: "run-2", model: "gpt-5.5" }),
      );

      assert.deepStrictEqual(
        ofKind(enqueued, "helper").map((helper) => [
          helper.recordKey,
          helper.args.sessionRef,
          helper.args.modelRef,
        ]),
        [
          ["helper:thread-child:run-1", "t3:environment-hq/thread-child/run-1", model],
          ["helper:thread-child:run-2", "t3:environment-hq/thread-child/run-2", "gpt-5.5"],
        ],
      );
    }),
  ),
);

it.effect("a helper queued while Weave cannot be read keeps its link's own Weave", () =>
  withReactor(({ reactor, enqueued, hq, state }) =>
    Effect.gen(function* () {
      state.items.set("spec-1", { kind: "spec", parentId: null });
      state.threads.set(
        lead,
        threadOf(lead, { workItem: { itemId: "spec-1", number: 1, origin } }),
      );
      state.threads.set(child, childOf(child, lead, "implementation-worker"));
      state.subagents.set(child, subagentOf(child));
      // Weave cannot be read at the moment the run finishes, so the row carries no Spec.
      hq.state.unreachable = true;

      yield* reactor.recordCompletion(child, finishedRunOf(child));

      const [helper] = ofKind(enqueued, "helper");
      assert.strictEqual(helper?.origin, origin);
      assert.isNull(helper?.specId);
    }),
  ),
);

it.effect("a follow-up run's helper record and run times carry that run's own times", () =>
  withReactor(({ reactor, enqueued, state }) =>
    Effect.gen(function* () {
      const laterStartedAt = "2026-10-01T12:00:00.000Z";
      const laterEndedAt = "2026-10-01T12:15:00.000Z";
      state.items.set("spec-1", { kind: "spec", parentId: null });
      state.threads.set(
        lead,
        threadOf(lead, { workItem: { itemId: "spec-1", number: 1, origin } }),
      );
      state.threads.set(child, childOf(child, lead, "implementation-worker"));
      state.threads.set(reviewer, childOf(reviewer, lead, "spec-reviewer"));
      // The delegate_task node keeps the times of the task that started first.
      state.subagents.set(child, subagentOf(child));
      state.subagents.set(reviewer, subagentOf(reviewer, { title: "Review package B" }));
      state.reviewerRuns.push({
        reviewerThreadId: reviewer,
        runId: "run-8",
        t3RunId: "run-9",
        specId: "spec-1",
        createdAt: 1,
      });

      const followUp = (threadId: ThreadId, id: string) =>
        finishedRunOf(threadId, {
          id,
          startedAt: at(laterStartedAt),
          completedAt: at(laterEndedAt),
        });
      yield* reactor.recordCompletion(child, followUp(child, "run-2"));
      yield* reactor.recordCompletion(reviewer, followUp(reviewer, "run-9"));

      const [helper] = ofKind(enqueued, "helper");
      assert.strictEqual(helper?.t3RunId, "run-2");
      assert.deepStrictEqual(helper?.args, {
        harness: "t3code",
        sessionRef: "t3:environment-hq/thread-child/run-2",
        modelRef: model,
        scope: "Implement package B",
        startedAt: laterStartedAt,
        endedAt: laterEndedAt,
        transcriptRef: "t3-thread://v1/thread-child",
      });
      assert.deepStrictEqual(ofKind(enqueued, "runtimes")[0]?.args, {
        runId: "run-8",
        startedAt: laterStartedAt,
        endedAt: laterEndedAt,
      });
    }),
  ),
);

it.effect(
  "a link queues its session while Weave cannot be read, and delivery resolves the Spec",
  () =>
    withReactor(({ reactor, enqueued, hq, state }) =>
      Effect.gen(function* () {
        const ticket = { itemId: "ticket-9", number: 9, origin };
        state.threads.set(lead, threadOf(lead, { workItem: ticket }));
        // Weave is unreachable exactly when the link is made.
        hq.state.unreachable = true;

        yield* reactor.handle(threadEvent("thread.created", threadOf(lead, { workItem: ticket })));

        const [session] = ofKind(enqueued, "session");
        // Queued without a Spec, which the delivery pass resolves when Weave answers again.
        assert.strictEqual(session?.recordKey, "session:thread-lead:ticket-9");
        assert.isUndefined(session?.specId);
        assert.strictEqual(session?.origin, origin);
        assert.deepStrictEqual(session?.bind, {});
        assert.deepStrictEqual(session?.startSession, {
          harness: "t3code",
          sessionRef: "thread-lead",
          modelRef: model,
          workspaces: [
            { repository: "pechhe/t3code", host: "agent-host", workspaceRef: worktreePath },
          ],
        });
      }),
    ),
);
