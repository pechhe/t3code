import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ThreadId,
} from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ARC_RUN_STALL_IDLE_MINUTES,
  ARC_RUN_STALL_OPEN_WORK_MINUTES,
  ARC_RUN_WATCHDOG_MINUTES,
  type ArcRunTrigger,
  decideArcRunWake,
  isDelegatedTaskDone,
  latestArcRunTurn,
  needsOwnerAnswer,
} from "./arcRun.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const PENDING_ITEMS = {
  turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
  turnItemStatuses: ["pending", "running", "waiting"],
} as const;

const WAITS_ON_NOBODY = new Set(["dynamic_tool_call", "auth_refresh"]);

export class ArcRunReactor extends Context.Service<
  ArcRunReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** One watchdog pass over every active run. Calls no model unless a run needs its lead. */
    readonly sweep: (trigger: Exclude<ArcRunTrigger, "event">) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ArcRunReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* SecureRandom.SecureRandom;
  const settings = yield* ServerSettings.ServerSettingsService;

  const newCommandId = Effect.fnUntraced(function* (threadId: ThreadId) {
    return CommandId.make(`server:arc-run-wake:${threadId}:${yield* crypto.uuidV4()}`);
  });

  // A cheap read picks the moment; the orchestrator decides again under the thread's lock. A
  // question asked after the turn ended travels with the wake, which answers it.
  const evaluate = Effect.fnUntraced(function* (threadId: ThreadId, trigger: ArcRunTrigger) {
    const records = yield* projections.getThreadRecords(
      threadId,
      ["runs", "subagents", "providerThreads", "turnItems", "runtimeRequests"],
      PENDING_ITEMS,
    );
    const decision = decideArcRunWake(records, trigger);
    if (decision === undefined) return;
    if (decision.kind === "failed-run") {
      // Recovery owns a limit failure only while its setting is on; otherwise this is the one path
      // left that can wake the lead, and the cap ends it visibly if the window stays closed.
      const { autoResumeLimitedThreads } = yield* settings.getSettings;
      const latest = latestArcRunTurn(records.runs);
      if (autoResumeLimitedThreads && latest !== undefined) {
        const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["error"],
          turnItemRunIds: [latest.id],
        });
        if (latestRootProviderFailure(latest, turnItems)?.class === "usage_limit") return;
      }
    }
    const questions = records.runtimeRequests.filter(
      (request) =>
        request.kind === "user_input" &&
        request.status === "pending" &&
        request.responseCapability.type === "message",
    );
    if (questions.length > 0) {
      const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["user_input_request"],
      });
      // A dialog only the owner can answer is a hold: the lead would only be told to wait for him.
      const ownerOnly = turnItems.some(
        (item) =>
          item.type === "user_input_request" &&
          questions.some((question) => question.id === item.requestId) &&
          needsOwnerAnswer(item.questions),
      );
      if (ownerOnly) return;
    }
    for (const request of questions) {
      yield* engine.dispatch({
        type: "thread.user-input.dismiss",
        commandId: CommandId.make(`server:arc-run-dismiss:${request.id}`),
        threadId,
        requestId: request.id,
      });
    }
    yield* engine.dispatch({
      type: "thread.arc-run.wake",
      commandId: yield* newCommandId(threadId),
      threadId,
      trigger,
      ...(questions.length > 0 ? { answersQuestion: true as const } : {}),
    });
  });

  /** Silence alone proves nothing: a child is only stalled if nothing else explains it. */
  const checkStalledChildren = Effect.fnUntraced(function* (thread: OrchestrationV2AppThread) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const { subagents } = yield* projections.getThreadRecords(thread.id, ["subagents"]);
    for (const task of subagents) {
      if (task.origin !== "app_owned" || task.childThreadId === null) continue;
      if (task.status !== "running") continue;
      const child = yield* projections.getThreadRecords(
        task.childThreadId,
        ["runs", "subagents", "runtimeRequests", "providerThreads", "turnItems"],
        PENDING_ITEMS,
      );
      const running = child.runs.findLast((run) => run.status === "running");
      if (running === undefined) continue;
      if (
        child.runtimeRequests.some(
          (request) => request.status === "pending" && !WAITS_ON_NOBODY.has(request.kind),
        )
      ) {
        continue;
      }
      if (
        child.subagents.some(
          (grandchild) =>
            grandchild.origin === "app_owned" && !isDelegatedTaskDone(grandchild.status),
        )
      ) {
        continue;
      }
      const rows = yield* sql<{ readonly sequence: number; readonly occurred_at: string }>`
        SELECT sequence, occurred_at FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${task.childThreadId}
        ORDER BY sequence DESC LIMIT 1
      `;
      const last = rows[0];
      if (last === undefined) continue;
      const quietMinutes = Math.floor((now - Date.parse(last.occurred_at)) / 60_000);
      const openWork =
        child.turnItems.length > 0 ||
        derivePendingBackgroundWork({
          latestRun: running,
          runs: child.runs,
          providerThreads: child.providerThreads,
          turnItems: child.turnItems,
          activeProviderThreadId: child.thread.activeProviderThreadId,
        }).length > 0;
      if (
        quietMinutes < (openWork ? ARC_RUN_STALL_OPEN_WORK_MINUTES : ARC_RUN_STALL_IDLE_MINUTES)
      ) {
        continue;
      }
      yield* engine.dispatch({
        type: "thread.arc-run.wake",
        commandId: yield* newCommandId(thread.id),
        threadId: thread.id,
        trigger: "watchdog",
        stall: {
          childThreadId: task.childThreadId,
          title: task.title?.trim() || child.thread.title,
          lastEventSequence: last.sequence,
          quietMinutes,
          openWork,
        },
      });
    }
  });

  // Untraced: it runs once per domain event, so a span per event would swamp traces.
  const handle: ArcRunReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "run.updated" || event.payload.status !== "completed") return;
      const thread = yield* projections.getThread(event.threadId);
      if (thread.arcRun?.state !== "active") return;
      yield* evaluate(event.threadId, "event");
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Arc run check failed", { threadId: event.threadId, cause }),
        ),
      ),
  );

  const sweep: ArcRunReactor["Service"]["sweep"] = (trigger) =>
    projections.listArcRunThreads().pipe(
      Effect.flatMap((threads) =>
        Effect.forEach(
          threads.filter((thread) => thread.arcRun?.state === "active"),
          (thread) =>
            Effect.all([evaluate(thread.id, trigger), checkStalledChildren(thread)], {
              discard: true,
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Arc run watchdog check failed", { threadId: thread.id, cause }),
              ),
            ),
          { discard: true },
        ),
      ),
      Effect.catchCause((cause) => Effect.logWarning("Arc run watchdog failed", { cause })),
    );

  const start: ArcRunReactor["Service"]["start"] = Effect.fn("ArcRunReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Arc run event stream failed", { cause })),
      ),
    );
    yield* forkParked(
      sweep("startup").pipe(
        Effect.andThen(
          sweep("watchdog").pipe(
            Effect.delay(`${ARC_RUN_WATCHDOG_MINUTES} minutes`),
            Effect.forever,
          ),
        ),
      ),
    );
  });

  return { start, handle, sweep } satisfies ArcRunReactor["Service"];
});

export const layer = Layer.effect(ArcRunReactor, make);
