import { assert, it } from "@effect/vitest";
import {
  type AgentTaskBinding,
  type ModelSelection,
  type OrchestrationV2ParkedWait,
  NodeId,
  RunId,
  RunAttemptId,
  MessageId,
  EventId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";

import * as ProjectionStore from "./ProjectionStore.ts";

const progressOf = delegatedTaskProgress;

const parentThreadId = ThreadId.make("thread:subagent-snoozed-parent");
const childThreadId = ThreadId.make("thread:subagent-awake-child");
const parentProviderInstanceId = ProviderInstanceId.make("codex");
const parentModelSelection = {
  instanceId: parentProviderInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const parentCreatedAt = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");
const snoozedAt = DateTime.makeUnsafe("2026-07-24T09:05:00.000Z");
const snoozedUntil = DateTime.makeUnsafe("2026-07-25T09:00:00.000Z");
const childCreatedAt = DateTime.makeUnsafe("2026-07-24T09:10:00.000Z");

function makeParentThread(): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: parentThreadId,
    projectId: ProjectId.make("project:subagent-snooze"),
    title: "Snoozed parent",
    providerInstanceId: parentProviderInstanceId,
    modelSelection: parentModelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/source",
    worktreePath: "/tmp/source-worktree",
    activeProviderThreadId: ProviderThreadId.make("provider-thread:subagent-snoozed-parent"),
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: parentThreadId,
    },
    forkedFrom: null,
    createdAt: parentCreatedAt,
    updatedAt: snoozedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil,
    snoozedAt,
    deletedAt: null,
    historyOrigin: "v1_import",
  };
}

function taskFixture() {
  const projection = ProjectionStore.emptyProjection({
    type: "thread.created",
    id: EventId.make("task-fixture"),
    threadId: parentThreadId,
    occurredAt: parentCreatedAt,
    payload: makeParentThread(),
  });
  const run: OrchestrationV2Run = {
    id: RunId.make("initial"),
    threadId: parentThreadId,
    ordinal: 1,
    providerInstanceId: parentProviderInstanceId,
    modelSelection: parentModelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("prompt"),
    rootNodeId: NodeId.make("root"),
    activeAttemptId: RunAttemptId.make("attempt"),
    status: "completed",
    requestedAt: parentCreatedAt,
    startedAt: parentCreatedAt,
    completedAt: childCreatedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
  return { projection: { ...projection, runs: [run] }, run };
}

/** A delegated child's thread: its result waits with the parent task's grace, not a plain thread's rule. */
function delegatedTaskFixture() {
  const fixture = taskFixture();
  const delegatedParentThreadId = ThreadId.make("thread:delegated-task-parent");
  return {
    ...fixture,
    projection: {
      ...fixture.projection,
      thread: {
        ...fixture.projection.thread,
        lineage: {
          parentThreadId: delegatedParentThreadId,
          relationshipToParent: "subagent" as const,
          rootThreadId: delegatedParentThreadId,
        },
      },
    },
  };
}

it.each([
  ["another thread", [{ kind: "thread", threadId: "thread:other" }], "waiting_for_children"],
  ["a Forge item", [{ kind: "build_item", number: 7, until: "closed" }], "waiting_for_children"],
  ["a landing", [{ kind: "landing", operationId: "op_1" }], "waiting_for_children"],
  ["Production", [{ kind: "production", commitId: "abc1234" }], "waiting_for_children"],
  ["a time", [{ kind: "time", at: "2026-07-25T09:00:00.000Z" }], "result_available"],
  [
    "a time and a landing",
    [
      { kind: "time", at: "2026-07-25T09:00:00.000Z" },
      { kind: "landing", operationId: "op_1" },
    ],
    "waiting_for_children",
  ],
] as const)("a delegated task waiting on %s gives its result: %s", (_name, targets, state) => {
  const { projection } = taskFixture();
  for (const role of ["lead", "implementer", "scout"] as const) {
    const progress = progressOf({
      ...projection,
      thread: {
        ...projection.thread,
        agentTask: { role } as AgentTaskBinding,
        parkedWaits: targets.map((target, index) => ({
          id: `wait:${index}`,
          title: "Wait",
          startedAt: "2026-07-24T09:00:00.000Z",
          target: target as OrchestrationV2ParkedWait["target"],
        })),
      },
    });
    assert.equal(progress.state, state, role);
  }
});

it("holds a plain thread's result for background work that a delegated child does not", () => {
  const { projection } = taskFixture();
  const roster = [
    {
      id: ProviderThreadId.make("provider-thread:background-audit"),
      pendingBackgroundTasks: [{ taskId: "background-audit", kind: "command" as const }],
    },
  ];
  // An ordinary top-level thread still waits for any of its own background work.
  assert.equal(
    progressOf({ ...projection, providerThreads: roster }).state,
    "waiting_for_children",
  );
  const { projection: delegated } = delegatedTaskFixture();
  // A delegated child holds only for work that would produce its result: an awaited command.
  assert.equal(progressOf({ ...delegated, providerThreads: roster }).state, "result_available");
  assert.equal(
    progressOf({
      ...delegated,
      providerThreads: [
        {
          ...roster[0]!,
          pendingBackgroundTasks: [{ taskId: "build", kind: "command" as const, awaited: true }],
        },
      ],
    }).state,
    "waiting_for_children",
  );
});

it("holds the result for pending background work and pull request watches, not thread watches", () => {
  const { projection, run } = taskFixture();
  const command = {
    id: TurnItemId.make("background-tests"),
    type: "command_execution" as const,
    status: "running" as const,
    title: null,
    runId: run.id,
    input: "vp test run",
  };
  // A background command the thread will be woken by delays its parent's delivery.
  assert.equal(progressOf({ ...projection, turnItems: [command] }).state, "waiting_for_children");
  assert.equal(
    progressOf({
      ...projection,
      turnItems: [{ ...command, status: "completed" as const }],
    }).state,
    "result_available",
  );
  const pullRequest = {
    host: "github.com",
    repository: "t3tools/t3code",
    number: 7,
    url: "https://github.com/t3tools/t3code/pull/7",
    source: "agent" as const,
    linkedAt: "2026-07-24T09:00:00.000Z",
    snapshot: null,
    stack: null,
  };
  const watch = {
    startedAt: "2026-07-24T09:00:00.000Z",
    headSha: null,
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarksThrough: "2026-07-24T09:00:00.000Z",
    remarkIds: [],
    conflicting: false,
    wakes: 0,
  };
  assert.equal(
    progressOf({
      ...projection,
      thread: { ...projection.thread, pullRequests: [{ ...pullRequest, watch }] },
    }).state,
    "waiting_for_children",
  );
  const watcher: OrchestrationV2AppThread = {
    ...projection.thread,
    pullRequests: [pullRequest],
    parkedWaits: [
      {
        id: "wait:a",
        target: { kind: "thread", threadId: childThreadId },
        title: "Child",
        startedAt: "2026-07-24T09:00:00.000Z",
      },
    ],
  };
  assert.equal(progressOf({ ...projection, thread: watcher }).state, "result_available");
});

it("holds a managed task for an awaited command until it ends, and never for one it did not await", () => {
  const { projection, run } = taskFixture();
  const managed = {
    ...projection,
    thread: {
      ...projection.thread,
      agentTask: { role: "scout" } as AgentTaskBinding,
    },
  };
  const poll = {
    id: TurnItemId.make("background-poll"),
    type: "command_execution" as const,
    status: "running" as const,
    title: null,
    runId: run.id,
    input: 'while pgrep -f "check" >/dev/null; do sleep 5; done',
  };
  // A command the child did not await is a dev server or watchdog: it publishes the result.
  assert.equal(progressOf({ ...managed, turnItems: [poll] }).state, "result_available");
  const awaited = {
    ...managed,
    providerThreads: [
      {
        id: ProviderThreadId.make("provider-thread:managed"),
        pendingBackgroundTasks: [
          {
            taskId: "bmtw1af16",
            description: 'while pgrep -f "check" >/dev/null; do sleep 5; done',
            kind: "command" as const,
            awaited: true as const,
          },
        ],
      },
    ],
  };
  // The child ended its turn to wait on it, so the result waits until the command ends and wakes
  // the child, however long that takes. Nothing is abandoned while it waits.
  const held = progressOf(awaited);
  assert.equal(held.state, "waiting_for_children");
  assert.deepEqual(held.abandonedBackgroundWork, []);
  // Work that will produce the task's result holds it too.
  assert.equal(
    progressOf({ ...managed, subagents: [{ status: "running" }] }).state,
    "waiting_for_children",
  );
  const pullRequest = {
    host: "github.com",
    repository: "t3tools/t3code",
    number: 7,
    url: "https://github.com/t3tools/t3code/pull/7",
    source: "agent" as const,
    linkedAt: "2026-07-24T09:00:00.000Z",
    snapshot: null,
    stack: null,
    watch: {
      startedAt: "2026-07-24T09:00:00.000Z",
      headSha: null,
      failedChecks: [],
      passed: false,
      passedChecks: [],
      remarksThrough: "2026-07-24T09:00:00.000Z",
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    },
  };
  assert.equal(
    progressOf({
      ...managed,
      thread: { ...managed.thread, pullRequests: [pullRequest] },
    }).state,
    "waiting_for_children",
  );
  assert.equal(
    progressOf({
      ...managed,
      providerThreads: [
        {
          id: ProviderThreadId.make("provider-thread:managed-review"),
          pendingBackgroundTasks: [{ taskId: "review", kind: "subagent" }],
        },
      ],
    }).state,
    "waiting_for_children",
  );
});

it.each(["failed", "cancelled", "interrupted"] as const)(
  "publishes a stored %s delegated run despite stale running tool items",
  (status) => {
    const { projection, run } = delegatedTaskFixture();
    const tool = {
      id: TurnItemId.make("image-read"),
      type: "dynamic_tool" as const,
      status: "running" as const,
      title: "read",
      runId: run.id,
      input: { path: "/tmp/image.png" },
    };
    assert.equal(progressOf({ ...projection, turnItems: [tool] }).state, "waiting_for_children");
    const stoppedRun = { ...run, status };
    const stored = {
      ...projection,
      runs: [stoppedRun],
      turnItems: [tool],
      pendingBlockingAdvice: true,
    };
    const progress = progressOf(stored);
    assert.equal(progress.state, "result_available");
    assert.equal(progress.resultRun?.status, status);
    assert.equal(
      progressOf({ ...stored, subagents: [{ status: "running" }] }).state,
      "waiting_for_children",
    );
    assert.equal(
      progressOf({ ...stored, subagents: [{ status: "completed" }] }).state,
      "result_available",
    );
    assert.equal(
      progressOf({
        ...stored,
        providerThreads: [
          {
            id: ProviderThreadId.make("provider:live-work"),
            pendingBackgroundTasks: [{ taskId: "live-work", kind: "background_task" }],
          },
        ],
      }).state,
      "waiting_for_children",
    );
    const later = { ...run, id: RunId.make("later"), ordinal: 2, status: "running" as const };
    assert.equal(
      progressOf({ ...projection, runs: [run, later], turnItems: [{ ...tool, runId: later.id }] })
        .state,
      "working",
    );
  },
);
