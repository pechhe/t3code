import {
  isProviderOverloadedFailureCode,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProviderOverloads from "../provider/ProviderOverloads.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** A retry in progress or a final failure that the provider reported as an overload. */
const overloadSignal = (event: OrchestrationV2DomainEvent) =>
  event.type === "turn-item.updated" &&
  event.payload.type === "error" &&
  // A recovered retry keeps the failure it recovered from; it is no new overload.
  event.payload.status !== "completed" &&
  isProviderOverloadedFailureCode(event.payload.failure.code) &&
  event.payload.runId !== null
    ? { threadId: event.payload.threadId, runId: event.payload.runId }
    : undefined;

/** Marks the account and model a run used as overloaded whenever its provider says so. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const overloads = yield* ProviderOverloads.ProviderOverloads;
    const mark = Effect.fn("ProviderOverloadMarker.mark")(function* (
      signal: NonNullable<ReturnType<typeof overloadSignal>>,
    ) {
      const records = yield* threads.getThreadRecords(signal.threadId, ["runs"]);
      const run = records.runs.find((candidate) => candidate.id === signal.runId);
      if (run === undefined) return;
      yield* overloads.mark({
        instanceId: run.modelSelection.instanceId,
        model: run.modelSelection.model,
      });
    });
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        const signal = overloadSignal(event);
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
