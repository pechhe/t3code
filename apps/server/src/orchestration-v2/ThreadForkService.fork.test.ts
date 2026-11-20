import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  EnvironmentId,
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
  sourceProjection = makeSourceProjection(sourceRun),
  options: { readonly sideChat?: boolean } = {},
) =>
  Effect.gen(function* () {
    const service = yield* ThreadForkService.ThreadForkServiceV2;
    return yield* service.plan({
      sourceProjection,
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
      ...options,
      createdBy: "user",
      creationSource: "mobile",
      createdAt: forkCreatedAt,
    });
  }).pipe(Effect.provide(ThreadForkService.layer));

it.effect(
  "resets a fork's pin, snooze, settle, delegation and Arc run state but keeps its origin",
  () =>
    Effect.gen(function* () {
      const linkOrigin = { sessionId: "mcp-session:fork-source", label: "Linked laptop" };
      const sourceThread: OrchestrationV2AppThread = {
        ...makeSourceThread(),
        lastSnoozeWakeAt: snoozedAt,
        pinnedAt: snoozedAt,
        pinOrderKey: "a0",
        activeOrderKey: "a1",
        autoSettleDisabledAt: snoozedAt,
        delegatedFrom: {
          environmentId: EnvironmentId.make("linked-environment"),
          threadId: ThreadId.make("linked-parent"),
          title: "Linked parent",
        },
        historyOrigin: "v1_import",
        linkOrigin,
        tags: ["private"],
        arcRun: {
          arc: { number: 12 },
          state: "active",
          startedAt: "2026-01-01T00:00:00.000Z",
          progressAt: "2026-01-01T00:00:00.000Z",
          ceilingSince: "2026-01-01T00:00:00.000Z",
        },
      };
      const sourceRun = makeSourceRun("completed");
      const result = yield* planFork(sourceRun, {
        ...makeSourceProjection(sourceRun),
        thread: sourceThread,
      });

      assert.isNull(result.targetThread.snoozedUntil);
      assert.isNull(result.targetThread.snoozedAt);
      assert.isNull(result.targetThread.lastSnoozeWakeAt);
      assert.isNull(result.targetThread.pinnedAt);
      assert.isNull(result.targetThread.pinOrderKey);
      assert.isNull(result.targetThread.activeOrderKey);
      assert.isNull(result.targetThread.autoSettleDisabledAt);
      assert.isUndefined(result.targetThread.delegatedFrom);
      assert.isUndefined(result.targetThread.arcRun);
      assert.equal(result.targetThread.historyOrigin, "v1_import");
      assert.deepEqual(result.targetThread.linkOrigin, linkOrigin);
      assert.deepEqual(result.targetThread.tags, ["private"]);
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
