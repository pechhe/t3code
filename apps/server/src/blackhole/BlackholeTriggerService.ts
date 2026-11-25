import {
  blackholeStatusText,
  runMemoryCycle,
  type RunWorker,
  type SessionEntry,
  type StatusWorker,
} from "@t3tools/blackhole";
import { blackholeCompactPoint } from "@t3tools/shared/blackholeCompactPoint";
import {
  CommandId,
  IDLE_COMPACTION_TEXT,
  isLeafSubagentThread,
  MessageId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as BlackholeMemoryStore from "./BlackholeMemoryStore.ts";
import { BlackholeStatusBoard } from "./BlackholeStatusBoard.ts";
import { blackholeCompacts, blackholeRemembers, BlackholeService } from "./BlackholeService.ts";

class BlackholeMemoryPassError extends Schema.TaggedError<BlackholeMemoryPassError>()(
  "BlackholeMemoryPassError",
  { cause: Schema.Defect() },
) {}

/**
 * After each completed run on a thread T3 runs Blackhole for: starts a memory pass on the Utility
 * model (observer, reflector, dropper; single-flight per thread), and when
 * the run's own context crossed the thread's compact point, queues `/compact` behind any work so
 * the compaction happens at a turn boundary and never interrupts a turn.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const blackhole = yield* BlackholeService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const store = yield* BlackholeMemoryStore.BlackholeMemoryStore;
  const statusBoard = yield* BlackholeStatusBoard;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const context = yield* Effect.context<never>();
  const passes = yield* FiberMap.make<ThreadId>();

  /** Puts Blackhole's status line on the thread's live provider session, for the context bar. */
  const publishStatus = Effect.fn("BlackholeTriggerService.publishStatus")(
    function* (
      threadId: ThreadId,
      entries: ReadonlyArray<SessionEntry> | undefined,
      worker?: StatusWorker,
    ) {
      const thread = yield* projections.getThread(threadId);
      if (thread.activeProviderThreadId === null) return;
      const { providerThreads, providerSessions } = yield* projections.getThreadRecords(
        threadId,
        ["providerThreads", "providerSessions"],
        { providerThreadIds: [thread.activeProviderThreadId] },
      );
      const providerThread = providerThreads.find(
        (candidate) => candidate.id === thread.activeProviderThreadId,
      );
      const session = providerSessions.find(
        (candidate) => candidate.id === providerThread?.providerSessionId,
      );
      if (providerThread === undefined || session === undefined) return;
      const current = yield* settings.getSettings;
      const usage = providerThread.contextUsage;
      const text = blackholeStatusText({
        entries: entries ?? [],
        memory: entries !== undefined,
        contextTokens: usage?.usedTokens ?? 0,
        compactPoint: blackholeCompactPoint({
          compactAt:
            thread.compactAt ?? current.modelCompactAt[thread.modelSelection.model] ?? null,
          windowTokens: usage?.maxTokens,
        }),
        ...(worker === undefined ? {} : { worker }),
      });
      statusBoard.set(session.id, text);
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId }),
            type: "provider-session.updated",
            threadId,
            driver: session.driver,
            providerInstanceId: session.providerInstanceId,
            occurredAt: now,
            payload: statusBoard.withStatus({ ...session, updatedAt: now }),
          },
        ],
      });
    },
    // The status line is a display; a thread it cannot reach just keeps its old one.
    (effect) => effect.pipe(Effect.ignoreCause),
  );

  const rememberNow = Effect.fn("BlackholeTriggerService.rememberNow")(
    function* (threadId: ThreadId) {
      const generate = textGeneration.generateBlackholeMemory;
      if (generate === undefined) return;
      const current = yield* settings.getSettings;
      const thread = yield* projections.getThread(threadId);
      const { entries, lastItemId } = yield* blackhole.session(threadId);
      if (lastItemId === undefined) return;
      const cwd = yield* blackhole.cwdOf(threadId);
      const runWorker: RunWorker = (request, signal) =>
        Effect.runPromiseWith(context)(
          publishStatus(threadId, entries, { kind: "running", stage: request.stage }).pipe(
            Effect.andThen(
              generate({
                cwd,
                stage: request.stage,
                system: request.system,
                prompt: request.prompt,
                toolName: request.tool.name,
                modelSelection: current.textGenerationModelSelection,
                projectId: thread.projectId,
              }),
            ),
            // An empty drop list is the dropper declining to call its tool.
            Effect.map((reply): unknown =>
              "ids" in reply && reply.ids.length === 0 ? null : reply,
            ),
          ),
          signal === undefined ? undefined : { signal },
        );
      const records = yield* Effect.tryPromise({
        try: (signal) => runMemoryCycle({ entries, runWorker, signal }),
        catch: (cause) => new BlackholeMemoryPassError({ cause }),
      }).pipe(
        // A failed worker must not leave its running marker on the context bar.
        Effect.tapError(() => publishStatus(threadId, entries)),
      );
      yield* store.append({
        threadId,
        anchorItemId: lastItemId,
        records,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      const recorded = records.at(-1);
      const settled = [
        ...entries,
        ...records.map((record, index): SessionEntry => ({
          type: "custom",
          id: `recorded-${index}`,
          timestamp: "",
          customType: record.customType,
          data: record.data,
        })),
      ];
      yield* publishStatus(
        threadId,
        settled,
        recorded === undefined
          ? undefined
          : {
              kind: "done",
              stage:
                recorded.customType === "om.observations.dropped"
                  ? "dropper"
                  : recorded.customType === "om.reflections.recorded"
                    ? "reflector"
                    : "observer",
              added: records.length,
            },
      );
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("blackhole memory pass failed", { threadId, cause }),
        ),
      ),
  );

  const afterRun = Effect.fn("BlackholeTriggerService.afterRun")(
    function* (threadId: ThreadId, runId: RunId) {
      const { blackhole: config, driver } = yield* blackhole.settingsFor(threadId);
      const thread = yield* projections.getThread(threadId);
      if (thread.deletedAt !== null || thread.lineage.sideChat === true) return;
      const remembers = blackholeRemembers(config, driver) && !isLeafSubagentThread(thread);
      if (remembers)
        yield* FiberMap.run(passes, threadId, rememberNow(threadId), { onlyIfMissing: true });
      if (!blackholeCompacts(config, driver)) return;
      if (!remembers) yield* publishStatus(threadId, undefined);

      const { runs, messages } = yield* projections.getThreadRecords(
        threadId,
        ["runs", "messages"],
        { runIds: [runId], messageRunIds: [runId] },
      );
      const run = runs.find((candidate) => candidate.id === runId);
      if (run === undefined || run.status !== "completed" || run.activeAttemptId === null) return;
      const message = messages.find((candidate) => candidate.id === run.userMessageId);
      // Never compact a compaction.
      if (message !== undefined && message.text.trim().toLowerCase() === IDLE_COMPACTION_TEXT)
        return;
      // Only the run's own provider turns: a run that never reached the provider (a compaction)
      // must not be judged on the session it replaced.
      const { providerTurns } = yield* projections.getThreadRecords(threadId, ["providerTurns"], {
        providerTurnAttemptIds: [run.activeAttemptId],
      });
      const usage = providerTurns
        .flatMap((turn) => (turn.tokenUsage === undefined ? [] : [turn.tokenUsage]))
        .reduce<(typeof providerTurns)[number]["tokenUsage"]>(
          (latest, candidate) =>
            latest === undefined || candidate.updatedAt > latest.updatedAt ? candidate : latest,
          undefined,
        );
      if (usage === undefined) return;
      const current = yield* settings.getSettings;
      const point = blackholeCompactPoint({
        compactAt: thread.compactAt ?? current.modelCompactAt[run.modelSelection.model] ?? null,
        windowTokens: usage.maxTokens,
      });
      if (point === undefined || usage.usedTokens < point) return;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        // One compaction per completed run, even across duplicate events.
        commandId: CommandId.make(`server:blackhole-compact:${threadId}:${runId}`),
        messageId: MessageId.make(`blackhole-compact:${threadId}:${runId}`),
        threadId,
        text: IDLE_COMPACTION_TEXT,
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("blackhole trigger skipped", { threadId, cause }),
        ),
      ),
  );

  const start = Effect.fn("BlackholeTriggerService.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "completed"
          ? afterRun(event.threadId, event.payload.id)
          : Effect.void,
      ),
    );
  });
  return { start, afterRun, rememberNow };
});
