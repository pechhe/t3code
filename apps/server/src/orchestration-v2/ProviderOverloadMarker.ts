import {
  isProviderOverloadedFailureCode,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProviderOverloads from "../provider/ProviderOverloads.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * A retry in progress or a final failure that the provider reported as an overload, or a
 * usage limit with the time it resets.
 */
const accountSignal = (event: OrchestrationV2DomainEvent) => {
  if (
    event.type !== "turn-item.updated" ||
    event.payload.type !== "error" ||
    // A recovered retry keeps the failure it recovered from; it is no new signal.
    event.payload.status === "completed" ||
    event.payload.runId === null
  )
    return undefined;
  const { failure, threadId, runId } = event.payload;
  if (isProviderOverloadedFailureCode(failure.code))
    return { kind: "overload" as const, threadId, runId };
  if (failure.class === "usage_limit" && failure.resetAt != null)
    return { kind: "usage-limit" as const, threadId, runId, resetAt: failure.resetAt };
  return undefined;
};

/**
 * Marks the account and model a run used as overloaded whenever its provider says so, and
 * remembers an account as out of usage until the reset a usage-limit failure reports.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const overloads = yield* ProviderOverloads.ProviderOverloads;
    const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    const mark = Effect.fn("ProviderOverloadMarker.mark")(function* (
      signal: NonNullable<ReturnType<typeof accountSignal>>,
    ) {
      const records = yield* threads.getThreadRecords(signal.threadId, ["runs"]);
      const run = records.runs.find((candidate) => candidate.id === signal.runId);
      if (run === undefined) return;
      if (signal.kind === "overload") {
        yield* overloads.mark({
          instanceId: run.modelSelection.instanceId,
          model: run.modelSelection.model,
        });
        return;
      }
      if (Option.isSome(registry))
        yield* registry.value.rememberUsageLimit({
          instanceId: run.modelSelection.instanceId,
          resetAt: signal.resetAt,
        });
    });
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        const signal = accountSignal(event);
        return signal === undefined
          ? Effect.void
          : mark(signal).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.provider-overload.mark-failed", {
                  threadId: signal.threadId,
                  cause,
                }),
              ),
            );
      }),
    );
  }),
);
