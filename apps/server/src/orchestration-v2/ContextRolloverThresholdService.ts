import type {
  OrchestrationV2GetRolloverThresholdsInput,
  OrchestrationV2RolloverThresholds,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Experiments from "../experiments/ExperimentService.ts";
import * as Settings from "../serverSettings.ts";
import {
  assignedRolloverThresholds,
  boundRolloverThresholds,
  compactionBoundary,
  compactsNatively,
  rolloverHeld,
} from "./ContextRollover.ts";
import * as Threads from "./ThreadManagementService.ts";

/**
 * Where a thread would be nudged to prepare for compaction, so clients can mark it on their
 * context meter. Built from the same rules the rollover reactor applies: the
 * thread's hold, its experiment assignment, the per-model rules and the
 * provider's context window. A thread not yet assigned to an experiment reads
 * the configured thresholds until its first usage report assigns it.
 */
export class ContextRolloverThresholdError extends Schema.TaggedError<ContextRolloverThresholdError>()(
  "ContextRolloverThresholdError",
  { cause: Schema.Defect() },
) {}

export class ContextRolloverThresholdService extends Context.Service<
  ContextRolloverThresholdService,
  {
    readonly read: (
      input: OrchestrationV2GetRolloverThresholdsInput,
    ) => Effect.Effect<OrchestrationV2RolloverThresholds, ContextRolloverThresholdError>;
  }
>()("t3/orchestration-v2/ContextRolloverThresholdService") {}

const make = Effect.gen(function* () {
  const settingsService = yield* Settings.ServerSettingsService;
  const threads = yield* Threads.ThreadManagementService;
  const experiments = yield* Experiments.ExperimentService;
  return ContextRolloverThresholdService.of({
    read: Effect.fn("ContextRolloverThresholdService.read")(
      function* (input) {
        const { thread } = yield* threads.getThreadRecords(input.threadId, []);
        if (rolloverHeld(thread.rolloverHold, yield* Clock.currentTimeMillis)) return null;
        const settings = yield* settingsService.getSettings;
        if (!compactsNatively(settings, thread.modelSelection.instanceId)) return null;
        const assignment = yield* experiments.getRolloverAssignment(input.threadId);
        const thresholds = assignedRolloverThresholds(
          settings.contextRollover,
          thread,
          input.model,
          assignment?.variant.rollover,
        );
        if (thresholds === null) return null;
        const { soft, hard } = boundRolloverThresholds(
          thresholds,
          compactionBoundary(input.maxTokens, settings, thread.modelSelection.instanceId),
        );
        return { soft, hard };
      },
      Effect.mapError((cause) => new ContextRolloverThresholdError({ cause })),
    ),
  });
});

export const layer = Layer.effect(ContextRolloverThresholdService, make);
