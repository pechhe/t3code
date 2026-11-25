import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { CompactionStartupSettle } from "../orchestration-v2/ClaudeCompactionTurnStart.ts";
import * as ContextHandoffService from "../orchestration-v2/ContextHandoffService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { blackholeCompacts, BlackholeService } from "./BlackholeService.ts";

const isCompactCommand = (message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<unknown>;
}) => message.attachments.length === 0 && message.text.trim().toLowerCase() === "/compact";

/**
 * `/compact` on a thread Blackhole compacts: settles the run before any provider turn with the
 * compiled block as a handoff and drops the native session, so the next turn starts fresh from
 * it. Undefined when Blackhole does not handle the run.
 */
export const make = Effect.gen(function* () {
  const blackhole = yield* BlackholeService;
  const contextHandoff = yield* ContextHandoffService.ContextHandoffServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  return Effect.fn("BlackholeCompactionTurnStart.compact")(function* (input: {
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "runs" | "providerTurns" | "subagents"
    >;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly run: OrchestrationV2Run;
    readonly message: { readonly text: string; readonly attachments: ReadonlyArray<unknown> };
  }): Effect.fn.Return<CompactionStartupSettle | undefined> {
    const { projection, providerThread, run } = input;
    if (!isCompactCommand(input.message)) return undefined;
    const { blackhole: settings } = yield* blackhole.settingsFor(projection.thread.id);
    if (!blackholeCompacts(settings, providerThread.driver)) return undefined;
    const settledAt = yield* DateTime.now;
    const base = {
      now: settledAt,
      startedAt: settledAt,
      providerInstanceId: run.providerInstanceId,
      itemProviderThreadId: providerThread.id,
    };
    const busyFailure = (moved: boolean): CompactionStartupSettle => ({
      ...base,
      signal: moved ? "compaction-session-moved" : "compaction-session-busy",
      status: "failed",
      item: {
        type: "error",
        title: "Cannot compact while this thread's work is running",
        failure: makeProviderFailure({
          class: "validation_error",
          message: moved
            ? "This conversation's session changed while Blackhole compacted it. Compact again."
            : "Stop this thread's background work, then compact again. A compaction replaces the conversation's session, which the running work is using.",
        }),
      },
    });
    const reread = yield* projections
      .getThreadRecords(projection.thread.id, ["providerThreads", "subagents"])
      .pipe(Effect.orElseSucceed(() => undefined));
    const current = reread?.providerThreads.find((candidate) => candidate.id === providerThread.id);
    if (current === undefined) return busyFailure(true);
    if (
      (current.pendingBackgroundTasks ?? []).length > 0 ||
      reread?.subagents.some(
        (subagent) => subagent.providerThreadId === current.id && subagent.status === "running",
      ) === true
    )
      return busyFailure(false);

    const compaction = yield* blackhole.compile(projection.thread.id);
    if (compaction === undefined) {
      return {
        ...base,
        signal: "compaction-empty",
        status: "failed",
        item: {
          type: "error",
          title: "Nothing to compact yet",
          failure: makeProviderFailure({
            class: "validation_error",
            message: "This conversation has nothing Blackhole can summarise yet.",
          }),
        },
      };
    }
    const handoff = yield* contextHandoff
      .prepareCompactionSummary({
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
        summaryText: compaction.text,
        createdAt: settledAt,
      })
      .pipe(Effect.orDie);
    const usages = projection.providerTurns.flatMap((turn) =>
      turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined
        ? [turn.tokenUsage]
        : [],
    );
    const before = usages.reduce<(typeof usages)[number] | undefined>(
      (latest, usage) =>
        latest === undefined || Date.parse(usage.updatedAt) > Date.parse(latest.updatedAt)
          ? usage
          : latest,
      undefined,
    );
    return {
      ...base,
      signal: "compaction-blackhole",
      status: "completed",
      item: {
        type: "compaction",
        driver: providerThread.driver,
        title: "Context compacted by Blackhole",
        summary: compaction.text,
        ...(before === undefined ? {} : { beforeTokenCount: before.usedTokens }),
        afterTokenCount: Math.ceil(Buffer.byteLength(compaction.text) / 4),
      },
      handoff,
      providerThreadUpdate: {
        ...current,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        contextUsage: null,
        status: "not_loaded",
        handoffIds: [...current.handoffIds, handoff.id],
        updatedAt: settledAt,
      },
    };
  });
});
