import * as Effect from "effect/Effect";

import type * as EffectOutbox from "./EffectOutbox.ts";
import type * as ThreadManagementService from "./ThreadManagementService.ts";

/** Stopping a thread pauses its delegated tasks; resuming it lets them run again. */
export const execute = <E>(
  threads: ThreadManagementService.ThreadManagementService["Service"],
  effect: EffectOutbox.OrchestrationEffectV2,
  fail: (input: {
    readonly effectId: string;
    readonly effectType: string;
    readonly cause: unknown;
  }) => E,
) => {
  const { request } = effect;
  const mapError = Effect.mapError((cause: unknown) =>
    fail({ effectId: effect.id, effectType: request.type, cause }),
  );
  return request.type === "delegated-tasks.stop"
    ? threads
        .stopDelegatedTasks({
          threadId: effect.threadId,
          commandId: effect.commandId,
          reason: request.reason,
        })
        .pipe(mapError)
    : threads
        .resumeDelegatedTasks({ threadId: effect.threadId, commandId: effect.commandId })
        .pipe(mapError);
};
