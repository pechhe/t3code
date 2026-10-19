import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ThreadForkService from "./ThreadForkService.ts";

const sourceThreadId = ThreadId.make("thread:fork-snoozed-source");
const targetThreadId = ThreadId.make("thread:fork-awake-target");
const sourceRunId = RunId.make("run:fork-snoozed-source");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const sourceCreatedAt = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");
const snoozedAt = DateTime.makeUnsafe("2026-07-24T09:05:00.000Z");
const snoozedUntil = DateTime.makeUnsafe("2026-07-25T09:00:00.000Z");
const forkCreatedAt = DateTime.makeUnsafe("2026-07-24T09:10:00.000Z");

function makeSourceThread(): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: sourceThreadId,
    projectId: ProjectId.make("project:fork-snooze"),
    title: "Snoozed source",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/source",
    worktreePath: "/tmp/source-worktree",
    activeProviderThreadId: ProviderThreadId.make("provider-thread:fork-snoozed-source"),
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: sourceThreadId,
    },
    forkedFrom: null,
    createdAt: sourceCreatedAt,
    updatedAt: snoozedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil,
    snoozedAt,
    deletedAt: null,
  };
}

function makeSourceRun(status: OrchestrationV2Run["status"]): OrchestrationV2Run {
  return {
    id: sourceRunId,
    threadId: sourceThreadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: ProviderThreadId.make("provider-thread:fork-snoozed-source"),
    userMessageId: MessageId.make("message:fork-snoozed-source"),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    queuePosition: null,
    requestedAt: sourceCreatedAt,
    startedAt: sourceCreatedAt,
    completedAt: snoozedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function makeSourceProjection(
  sourceRun: OrchestrationV2Run,
  thread: OrchestrationV2AppThread = makeSourceThread(),
): OrchestrationV2ThreadProjection {
  return {
    thread,
    runs: [sourceRun],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: snoozedAt,
  };
}

const planFork = (
  sourceRun: OrchestrationV2Run,
  options: { readonly sourceThread?: OrchestrationV2AppThread; readonly sideChat?: boolean } = {},
) =>
  Effect.gen(function* () {
    const service = yield* ThreadForkService.ThreadForkServiceV2;
    return yield* service.plan({
      sourceProjection: makeSourceProjection(sourceRun, options.sourceThread),
      ...(options.sideChat === undefined ? {} : { sideChat: options.sideChat }),
      sourceRun,
      sourceProviderThread: undefined,
      canonicalSourcePoint: {
        threadId: sourceThreadId,
        runId: sourceRunId,
      },
      transferId: ContextTransferId.make("context-transfer:fork-snoozed-source"),
      targetThreadId,
      title: "Awake fork",
      createdBy: "user",
      creationSource: "mobile",
      createdAt: forkCreatedAt,
    });
  }).pipe(Effect.provide(ThreadForkService.layer));

it("treats usage-limited and other provider-finished runs as forkable", () => {
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("completed"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("waiting"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("failed"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("interrupted"));
  assert.isTrue(ThreadForkService.isForkableSourceRunStatus("cancelled"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("running"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("starting"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("queued"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("preparing"));
  assert.isFalse(ThreadForkService.isForkableSourceRunStatus("rolled_back"));
});

it.effect("keeps a fork awake when its source thread is snoozed", () =>
  Effect.gen(function* () {
    const sourceThread = makeSourceThread();
    const sourceRun = makeSourceRun("completed");
    const result = yield* planFork(sourceRun);

    assert.isNull(result.targetThread.snoozedUntil);
    assert.isNull(result.targetThread.snoozedAt);
    assert.equal(result.targetThread.projectId, sourceThread.projectId);
    assert.equal(result.targetThread.providerInstanceId, sourceThread.providerInstanceId);
    assert.deepEqual(result.targetThread.modelSelection, sourceThread.modelSelection);
    assert.equal(result.targetThread.runtimeMode, sourceThread.runtimeMode);
    assert.equal(result.targetThread.interactionMode, sourceThread.interactionMode);
    assert.equal(result.targetThread.branch, sourceThread.branch);
    assert.equal(result.targetThread.worktreePath, sourceThread.worktreePath);
    assert.isNull(result.targetThread.activeProviderThreadId);
    assert.deepEqual(result.targetThread.lineage, {
      parentThreadId: sourceThreadId,
      relationshipToParent: "fork",
      rootThreadId: sourceThreadId,
    });
    assert.deepEqual(result.targetThread.forkedFrom, {
      type: "run",
      threadId: sourceThreadId,
      runId: sourceRunId,
    });
  }),
);

it.effect("forks from a usage-limited failed run", () =>
  Effect.gen(function* () {
    const result = yield* planFork(makeSourceRun("failed"));
    assert.deepEqual(result.targetThread.forkedFrom, {
      type: "run",
      threadId: sourceThreadId,
      runId: sourceRunId,
    });
  }),
);

it.effect("preserves pull request context without inheriting any watches", () =>
  Effect.gen(function* () {
    const sourceRun = makeSourceRun("completed");
    const watch = {
      startedAt: DateTime.formatIso(sourceCreatedAt),
      headSha: "source-head",
      failedChecks: ["lint"],
      passed: false,
      passedChecks: [],
      remarksThrough: DateTime.formatIso(snoozedAt),
      remarkIds: ["review-1"],
      conflicting: true,
      wakes: 2,
    };
    const links = (["agent", "stack", "manual", "stack-dismissed"] as const).map(
      (source, index) =>
        ({
          host: "github.com",
          repository: "example/repo",
          number: index + 1,
          url: `https://github.com/example/repo/pull/${index + 1}`,
          source,
          linkedAt: DateTime.formatIso(sourceCreatedAt),
          snapshot: {
            state: "open",
            title: `Pull request ${index + 1}`,
            headBranch: `feature-${index + 1}`,
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: DateTime.formatIso(snoozedAt),
          },
          stack: {
            kind: "native",
            id: "stack-1",
            number: 1,
            url: "https://github.com/example/repo/stack/1",
            base: "main",
            layers: [{ number: 1, headBranch: "feature-1", state: "open" }],
          },
        }) satisfies ThreadPullRequestLink,
    );
    const watchedLinks: ReadonlyArray<ThreadPullRequestLink> = links.map((link, index) =>
      index < 2 ? { ...link, watch } : link,
    );
    const legacyLink = {
      projectId: makeSourceThread().projectId,
      repository: "example/repo",
      number: 1,
      url: links[0]!.url,
    };
    const sourceThread = {
      ...makeSourceThread(),
      pullRequests: watchedLinks,
      linkedPullRequest: legacyLink,
      branchPullRequest: legacyLink,
    };
    const result = yield* planFork(sourceRun, { sourceThread });

    assert.deepEqual(result.targetThread.pullRequests, links);
    assert.deepEqual(result.targetThread.linkedPullRequest, legacyLink);
    assert.deepEqual(result.targetThread.branchPullRequest, legacyLink);
    assert.deepEqual(sourceThread.pullRequests, watchedLinks);
    assert.deepEqual(sourceThread.pullRequests[0]?.watch, watch);
    assert.deepEqual(sourceThread.pullRequests[1]?.watch, watch);
  }),
);

it.effect("rejects in-progress and rolled-back fork sources", () =>
  Effect.gen(function* () {
    for (const status of ["running", "rolled_back"] as const) {
      const sourceRun = makeSourceRun(status);
      const error = yield* planFork(sourceRun).pipe(Effect.flip);
      assert.equal(error._tag, "ThreadForkPlanError");
      assert.equal(error.sourceThreadId, sourceThreadId);
      assert.equal(error.targetThreadId, targetThreadId);
      assert.equal(error.cause, ThreadForkService.forkableSourceRunStatusError(sourceRun));
    }
  }),
);

it.effect("opens a side chat without the source's list placement or pull requests", () =>
  Effect.gen(function* () {
    const pinnedAt = DateTime.makeUnsafe("2026-07-24T09:01:00.000Z");
    const pullRequest = {
      projectId: ProjectId.make("project:fork-snooze"),
      repository: "pechhe/t3code",
      number: 12,
      url: "https://github.com/pechhe/t3code/pull/12",
    };
    const sourceThread: OrchestrationV2AppThread = {
      ...makeSourceThread(),
      pinnedAt,
      pinOrderKey: "a0",
      activeOrderKey: "a1",
      linkedPullRequest: pullRequest,
      branchPullRequest: pullRequest,
    };
    const result = yield* planFork(makeSourceRun("completed"), { sourceThread, sideChat: true });

    assert.isTrue(result.targetThread.sideChat);
    assert.isNull(result.targetThread.pinnedAt);
    assert.isNull(result.targetThread.pinOrderKey);
    assert.isNull(result.targetThread.activeOrderKey);
    assert.isNull(result.targetThread.linkedPullRequest);
    assert.isNull(result.targetThread.branchPullRequest);
    assert.deepEqual(result.targetThread.pullRequests, []);
    // The side chat keeps the source's model, so it can reuse the native session.
    assert.deepEqual(result.targetThread.modelSelection, sourceThread.modelSelection);
    assert.equal(result.targetThread.lineage.relationshipToParent, "fork");
  }),
);

it.effect("forks a side chat into an ordinary fork", () =>
  Effect.gen(function* () {
    const sourceThread: OrchestrationV2AppThread = { ...makeSourceThread(), sideChat: true };
    const result = yield* planFork(makeSourceRun("completed"), { sourceThread });

    assert.isUndefined(result.targetThread.sideChat);
  }),
);
