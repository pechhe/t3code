import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ProviderOverloads from "../provider/ProviderOverloads.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderOverloadMarker from "./ProviderOverloadMarker.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:overload");
const runId = RunId.make("run:overload");
const instanceId = ProviderInstanceId.make("pi");
const model = "opencode-go/deepseek-v4.1-flash";

const errorEvent = (code: string | null, status = "running") =>
  ({
    type: "turn-item.updated",
    payload: {
      type: "error",
      status,
      threadId,
      runId,
      failure: { class: "provider_error", message: "Provider failed.", code, retryable: true },
    },
  }) as unknown as OrchestrationV2DomainEvent;

it.effect("marks the run's account and model only for an overload failure", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const overloads = yield* ProviderOverloads.ProviderOverloads.pipe(
      Effect.provide(ProviderOverloads.layer),
    );
    const marked = yield* Queue.unbounded<{
      readonly instanceId: string;
      readonly model: string;
    }>();
    yield* Layer.build(
      ProviderOverloadMarker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderOverloads.ProviderOverloads, {
              ...overloads,
              mark: (input) =>
                overloads.mark(input).pipe(Effect.andThen(Queue.offer(marked, input))),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromQueue(events),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadRecords: () =>
                Effect.succeed({
                  runs: [
                    { id: runId, modelSelection: { instanceId, model } } as OrchestrationV2Run,
                  ],
                } as never),
            }),
          ),
        ),
      ),
    );
    const key = ProviderOverloads.providerOverloadKey(instanceId, model);

    // Events are handled in order, so the first mark proves the earlier ones marked nothing.
    yield* Queue.offer(events, errorEvent("api_error_429"));
    yield* Queue.offer(events, errorEvent(null));
    // A recovered retry still carries the overload it recovered from.
    yield* Queue.offer(events, errorEvent("overloaded", "completed"));
    yield* Queue.offer(events, errorEvent("overloaded"));
    assert.deepEqual(yield* Queue.take(marked), { instanceId, model });
    assert.equal(yield* Queue.size(marked), 0);
    assert.equal(
      (yield* overloads.current).get(key),
      DateTime.toEpochMillis(yield* DateTime.now) + ProviderOverloads.PROVIDER_OVERLOAD_COOLDOWN_MS,
    );
  }),
);
