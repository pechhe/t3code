import {
  OrchestratorMcpFailure,
  PREVIEW_TASK_REASON_FAULT,
  type PreviewTaskFault,
  type PreviewTaskReason,
  type PreviewTaskResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";

export type BrowserTaskCallMode = "steps" | "goal" | "page-reach";
export type BrowserTaskCallOutcome = PreviewTaskResult["status"] | "refused";

export interface BrowserTaskCall {
  readonly mode: BrowserTaskCallMode;
  readonly outcome: BrowserTaskCallOutcome;
  readonly reason: PreviewTaskReason | null;
  readonly fault: PreviewTaskFault | null;
  readonly decisions: number;
  readonly durationMs: number;
  /** A repeated `requestId` reads an earlier run's state: a call, but not another run. */
  readonly replayed: boolean;
}

const KEEP_FOR = Duration.days(90);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);

/** The mode a request asks for, read from whatever the caller sent, decodable or not. */
export const callMode = (request: unknown): BrowserTaskCallMode => {
  const fields = typeof request === "object" && request !== null ? request : {};
  if ("steps" in fields && fields.steps !== undefined) return "steps";
  if ("pageReach" in fields && fields.pageReach !== undefined) return "page-reach";
  return "goal";
};

const refusal = (reason: PreviewTaskReason) => ({
  outcome: "refused" as const,
  reason,
  fault: PREVIEW_TASK_REASON_FAULT[reason],
  decisions: 0,
  replayed: false,
});

/** A call the tool layer refused before it ran: its parameters did not decode. */
export const undecodedCall = refusal("invalid-request");

/** What a finished call leaves on record: the run's own result, or why it was refused. */
export const callFacts = (
  exit: Exit.Exit<PreviewTaskResult, unknown>,
): Omit<BrowserTaskCall, "mode" | "durationMs"> => {
  if (Exit.isSuccess(exit))
    return {
      outcome: exit.value.status,
      reason: exit.value.reason ?? null,
      fault: exit.value.fault ?? null,
      decisions: exit.value.decisions,
      replayed: exit.value.replayed === true,
    };
  const failure = exit.cause.reasons.find(Cause.isFailReason)?.error;
  return refusal(
    !isMcpFailure(failure)
      ? "internal-error"
      : failure.code === "capability_denied"
        ? "not-authorized"
        : "invalid-request",
  );
};

/**
 * The environment's durable record of bounded browser task calls, read by `t3 browser report`.
 * It holds no page content, typed values, logins or URLs.
 */
export class BrowserTaskCalls extends Context.Service<
  BrowserTaskCalls,
  {
    readonly record: (scope: McpInvocationScope, call: BrowserTaskCall) => Effect.Effect<void>;
  }
>()("t3/browserTasks/BrowserTaskCalls") {}

/** Records the call around `effect` once it ends, however it ends; recording never fails it. */
export const recorded = Effect.fn("BrowserTaskCalls.recorded")(function* <E, R>(
  calls: Option.Option<BrowserTaskCalls["Service"]>,
  scope: McpInvocationScope,
  request: unknown,
  effect: Effect.Effect<PreviewTaskResult, E, R>,
) {
  if (Option.isNone(calls)) return yield* effect;
  const startedAt = yield* Clock.currentTimeMillis;
  return yield* effect.pipe(
    Effect.onExit((exit) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((endedAt) =>
          calls.value.record(scope, {
            ...callFacts(exit),
            mode: callMode(request),
            durationMs: Math.max(0, endedAt - startedAt),
          }),
        ),
      ),
    ),
  );
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const adapters = yield* Effect.serviceOption(ProviderAdapterRegistry.ProviderAdapterRegistryV2);
  const harnessOf = (scope: McpInvocationScope) =>
    scope.thread === undefined
      ? Effect.succeed(scope.client === undefined ? "unknown" : "client")
      : Option.isNone(adapters)
        ? Effect.succeed(String(scope.thread.providerInstanceId))
        : adapters.value.get(scope.thread.providerInstanceId).pipe(
            Effect.map((adapter): string => adapter.driver),
            Effect.orElseSucceed(() => String(scope.thread!.providerInstanceId)),
          );

  return BrowserTaskCalls.of({
    record: Effect.fn("BrowserTaskCalls.record")(function* (scope, call) {
      const harness = yield* harnessOf(scope);
      const now = yield* DateTime.now;
      const cutoff = DateTime.formatIso(DateTime.subtractDuration(now, KEEP_FOR));
      yield* sql
        .withTransaction(
          Effect.all([
            sql`INSERT INTO browser_task_calls (
              recorded_at, harness, mode, outcome, reason, fault, decisions, duration_ms, replayed
            ) VALUES (
              ${DateTime.formatIso(now)}, ${harness}, ${call.mode}, ${call.outcome},
              ${call.reason}, ${call.fault}, ${call.decisions}, ${Math.round(call.durationMs)},
              ${call.replayed ? 1 : 0}
            )`,
            sql`DELETE FROM browser_task_calls WHERE recorded_at < ${cutoff}`,
          ]),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not record a bounded browser task call.", { cause }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(BrowserTaskCalls, make);
