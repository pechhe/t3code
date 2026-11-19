import {
  resolveClaudeCompactionSetting,
  TextGenerationError,
  type ModelSelection,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  knownProviderFailureMessage,
  makeProviderFailure,
} from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { planClaudeCompaction } from "./ClaudeCompactionPlan.ts";
import {
  clampCompactionSummary,
  COMPACTION_SUMMARY_MAX_BYTES,
  COMPACTION_TRANSCRIPT_ITEM_TYPES,
  DEFAULT_COMPACTION_WINDOW_TOKENS,
  renderCompactionTranscript,
} from "./CompactionTranscript.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderTurnStartError } from "./ProviderTurnStartService.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

/** What a Claude `/compact` turn start needs from the run being started. */
export interface CompactionTurnStartInput {
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "providerTurns" | "subagents"
  >;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly run: OrchestrationV2Run;
  readonly message: { readonly text: string; readonly attachments: ReadonlyArray<unknown> };
}

/** How the turn start settles a compaction it wrote on another account, or refused. */
export interface CompactionStartupSettle {
  readonly signal: string;
  readonly status: "completed" | "failed";
  readonly now: DateTime.Utc;
  readonly startedAt: DateTime.Utc;
  readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
  readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"];
  readonly item:
    | Pick<Extract<OrchestrationV2TurnItem, { type: "error" }>, "type" | "title" | "failure">
    | Pick<
        Extract<OrchestrationV2TurnItem, { type: "compaction" }>,
        "type" | "driver" | "title" | "summary" | "model" | "beforeTokenCount" | "afterTokenCount"
      >;
  readonly handoff?: OrchestrationV2ContextHandoff;
  readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
}

/**
 * The fork's compaction model for Claude threads (fork/differences.md `compact-model`): plans
 * which model writes a `/compact` summary and, for a model on another account, writes it.
 */
export const make = Effect.gen(function* () {
  const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  // Optional: a layer without managed agents has no chore worker to fall back on.
  const managedAgents = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;

  const plan = Effect.fn("ProviderTurnStartService.planCompaction")(function* (
    input: CompactionTurnStartInput,
  ) {
    const { projection, providerThread, run, message } = input;
    // The server cannot tell a typed /compact from compact-on-send or idle compaction, so all
    // of them follow the instance's "Compact with" setting.
    const compactionUsages = projection.providerTurns.flatMap((turn) =>
      turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined
        ? [turn.tokenUsage]
        : [],
    );
    const plannedCompaction =
      providerThread.driver === "claudeAgent" &&
      message.attachments.length === 0 &&
      message.text.trim().toLowerCase() === "/compact"
        ? planClaudeCompaction({
            setting: resolveClaudeCompactionSetting(
              yield* serverSettings.getSettings.pipe(
                Effect.orElseSucceed(() => ({ providerInstances: {} })),
              ),
              run.providerInstanceId,
            ),
            runInstanceId: run.providerInstanceId,
            modelSelection: run.modelSelection,
            usages: compactionUsages,
            nowMs: DateTime.toEpochMillis(yield* DateTime.now),
          })
        : ({ kind: "conversation" } as const);
    // The chore worker's models in the order its role would try them: the default summariser
    // when no model is set, and the fallbacks when the chosen one fails.
    const choreWorkerModels =
      plannedCompaction.kind === "summary" || plannedCompaction.kind === "choreWorker"
        ? yield* Effect.gen(function* () {
            if (Option.isNone(managedAgents)) return [];
            const providers = yield* Effect.forEach(
              yield* providerInstances.listInstances,
              (instance) =>
                instance.snapshot.getSnapshot.pipe(Effect.orElseSucceed(() => undefined)),
            );
            return yield* managedAgents.value.rankedTextModels({
              providers: providers.filter(
                (provider): provider is ServerProvider => provider !== undefined,
              ),
            });
          }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<ModelSelection>))
        : [];
    const compactionPlan =
      plannedCompaction.kind !== "choreWorker"
        ? plannedCompaction
        : choreWorkerModels[0] === undefined
          ? ({ kind: "conversation" } as const)
          : ({ kind: "summary", modelSelection: choreWorkerModels[0] } as const);
    return { plan: compactionPlan, choreWorkerModels, compactionUsages };
  });

  type Planned = Effect.Success<ReturnType<typeof plan>>;

  /**
   * Writes the summary on the planned model's account and replaces the conversation's session
   * with it, falling back through the chore worker's models. Returns how the run settles, or the
   * failure to rethrow when the start will be retried.
   */
  const compactOnAnotherAccount = Effect.fn("ProviderTurnStartService.compactOnAnotherAccount")(
    function* (
      input: CompactionTurnStartInput & {
        readonly planned: Planned & {
          readonly plan: Extract<Planned["plan"], { kind: "summary" }>;
        };
        readonly cwd: string;
        readonly willRetry: boolean;
        readonly startError: (cause: string) => ProviderTurnStartError;
      },
    ) {
      const { projection, providerThread, run, startError } = input;
      const { choreWorkerModels, compactionUsages } = input.planned;
      const summariser = input.planned.plan.modelSelection;
      const modelName = summariser.model;
      const busy =
        (providerThread.pendingBackgroundTasks ?? []).length > 0 ||
        projection.subagents.some(
          (subagent) =>
            subagent.providerThreadId === providerThread.id && subagent.status === "running",
        );
      const settledAt = yield* DateTime.now;
      if (busy) {
        return {
          _tag: "Settle",
          settle: {
            signal: "compaction-session-busy",
            status: "failed",
            now: settledAt,
            startedAt: settledAt,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: `Cannot compact with ${modelName} while this thread's work is running`,
              failure: makeProviderFailure({
                class: "validation_error",
                message: `Stop this thread's background work, then compact again. A compaction on ${modelName} replaces the conversation's session, which the running work is using.`,
              }),
            },
          },
        } satisfies CompactionStartOutcome;
      }
      const writeSummary = Effect.fn("ProviderTurnStartService.writeCompactionSummary")(function* (
        candidate: ModelSelection,
      ) {
        const modelName = candidate.model;
        const summariserInstance = yield* providerInstances.getInstance(candidate.instanceId);
        if (summariserInstance === undefined) {
          return yield* startError(
            `The account chosen to compact this thread is no longer available.`,
          );
        }
        const summariserSnapshot = yield* summariserInstance.snapshot.getSnapshot.pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const windowTokens =
          summariserSnapshot?.models.find((model) => model.slug === candidate.model)
            ?.contextWindowTokens ?? DEFAULT_COMPACTION_WINDOW_TOKENS;
        // The turn-start projection holds only this run's items, so read the whole thread.
        const history = yield* projectionStore.getTurnStartHistory(
          projection.thread.id,
          undefined,
          COMPACTION_TRANSCRIPT_ITEM_TYPES,
        );
        const transcript = renderCompactionTranscript({
          items: history.filter((item) => item.runId !== run.id),
          windowTokens,
        });
        if (transcript.text === "") {
          return yield* startError(
            `There was no conversation to send ${modelName}, so the session was kept.`,
          );
        }
        const threadTitle = projection.thread.title?.trim() ?? "";
        const generated = yield* summariserInstance.textGeneration.generateCompactionSummary({
          cwd: input.cwd,
          transcript: transcript.text,
          ...(threadTitle === "" ? {} : { threadTitle }),
          modelSelection: candidate,
        });
        const text = clampCompactionSummary(generated.summary, COMPACTION_SUMMARY_MAX_BYTES);
        if (text === "") {
          return yield* startError(`${modelName} returned no summary.`);
        }
        return { summary: text, model: candidate.model };
      });
      // The chosen model first; when it fails (out of allowance, overloaded, gone), the chore
      // worker's models in the order its role would try them.
      const summariserCandidates = [
        summariser,
        ...choreWorkerModels.filter(
          (candidate) =>
            candidate.instanceId !== summariser.instanceId || candidate.model !== summariser.model,
        ),
      ];
      // A failed run reports the chosen model's error, not a fallback's.
      const summaryResult = yield* Effect.result(
        summariserCandidates
          .slice(1)
          .reduce(
            (previous, candidate) =>
              previous.pipe(
                Effect.catch((firstError) =>
                  writeSummary(candidate).pipe(Effect.mapError(() => firstError)),
                ),
              ),
            writeSummary(summariserCandidates[0]!),
          ),
      );
      if (summaryResult._tag === "Failure") {
        if (input.willRetry) return { _tag: "Retry", error: summaryResult.failure } as const;
        const failure = summaryResult.failure;
        const detail =
          knownProviderFailureMessage(failure) ??
          (failure._tag === "ProviderTurnStartError"
            ? String(failure.cause)
            : isTextGenerationError(failure)
              ? failure.detail
              : "The summary could not be written.");
        return {
          _tag: "Settle",
          settle: {
            signal: "compaction-summary-failed",
            status: "failed",
            now: settledAt,
            startedAt: settledAt,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: `Compacting context with ${modelName} failed`,
              failure: makeProviderFailure({ class: "provider_error", message: detail }),
            },
          },
        } satisfies CompactionStartOutcome;
      }
      const summary = summaryResult.success.summary;
      const summarisedBy = summaryResult.success.model;
      // Dropping the session is decided on state read before a minutes-long model call, so
      // re-read it: a turn that started meanwhile owns work this write must not strand.
      const reread = yield* projectionStore
        .getThreadRecords(projection.thread.id, ["providerThreads", "subagents"])
        .pipe(Effect.orElseSucceed(() => undefined));
      const currentThread =
        reread?.providerThreads.find((candidate) => candidate.id === providerThread.id) ??
        undefined;
      const threadMoved =
        currentThread === undefined ||
        currentThread.nativeThreadRef?.nativeId !== providerThread.nativeThreadRef?.nativeId;
      const threadBusy =
        !threadMoved &&
        ((currentThread.pendingBackgroundTasks ?? []).length > 0 ||
          reread?.subagents.some(
            (subagent) =>
              subagent.providerThreadId === providerThread.id && subagent.status === "running",
          ) === true);
      if (threadMoved || threadBusy) {
        return {
          _tag: "Settle",
          settle: {
            signal: threadMoved ? "compaction-session-moved" : "compaction-session-busy",
            status: "failed",
            now: settledAt,
            startedAt: settledAt,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: `Cannot compact with ${summarisedBy} while this thread's work is running`,
              failure: makeProviderFailure({
                class: "validation_error",
                message: threadMoved
                  ? `This conversation's session changed while ${summarisedBy} wrote the summary. Compact again.`
                  : `Stop this thread's background work, then compact again. A compaction on ${summarisedBy} replaces the conversation's session, which the running work is using.`,
              }),
            },
          },
        } satisfies CompactionStartOutcome;
      }
      // The provider's own session still holds every token the summary replaces, so the next
      // turn opens a fresh one and this handoff is the whole conversation it starts from.
      const handoff = yield* contextHandoffService.prepareCompactionSummary({
        threadId: projection.thread.id,
        targetRunId: run.id,
        fromProviderThreadIds: [providerThread.id],
        toProviderThreadId: providerThread.id,
        fromProviderInstanceId: providerThread.providerInstanceId,
        toProviderInstanceId: run.providerInstanceId,
        coveredRunOrdinals: {
          from: projection.runs.at(0)?.ordinal ?? run.ordinal,
          to: run.ordinal,
        },
        summaryText: summary,
        createdAt: settledAt,
      });
      return {
        _tag: "Settle",
        settle: {
          signal: "compaction-on-another-account",
          status: "completed",
          now: settledAt,
          startedAt: settledAt,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "compaction",
            driver: providerThread.driver,
            title: `Context compacted with ${summarisedBy}`,
            summary,
            model: summarisedBy,
            ...(compactionUsages.length === 0
              ? {}
              : {
                  beforeTokenCount: compactionUsages.reduce(
                    (latest, usage) =>
                      Date.parse(usage.updatedAt) > Date.parse(latest.updatedAt) ? usage : latest,
                    compactionUsages[0]!,
                  ).usedTokens,
                }),
            afterTokenCount: Math.ceil(Buffer.byteLength(summary) / 4),
          },
          handoff,
          providerThreadUpdate: {
            ...currentThread,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            contextUsage: null,
            status: "not_loaded",
            handoffIds: [...currentThread.handoffIds, handoff.id],
            updatedAt: settledAt,
          },
        },
      } satisfies CompactionStartOutcome;
    },
  );

  return { plan, compactOnAnotherAccount } as const;
});

type CompactionStartOutcome = { readonly _tag: "Settle"; readonly settle: CompactionStartupSettle };
