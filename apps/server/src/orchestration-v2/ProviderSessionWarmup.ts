import type { ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

/**
 * Opens a thread's provider session before its first message, under the id the Orchestrator gives
 * that first run (`IdAllocator.derive.firstProviderSession`), so the first turn finds the process
 * already started. Best effort: a session that fails to open here is opened as usual on Send.
 */
export class ProviderSessionWarmup extends Context.Service<
  ProviderSessionWarmup,
  {
    readonly warm: (threadId: ThreadId) => Effect.Effect<void>;
    /** Closes a session opened ahead for a thread that never ran. */
    readonly release: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ProviderSessionWarmup") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const adapters = yield* ProviderAdapterRegistryV2;
  const sessions = yield* ProviderSessionManagerV2;
  const runtimePolicy = yield* RuntimePolicyV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;

  // Only a thread that has never run, on a provider that gives each thread its own session.
  const target = Effect.fn("ProviderSessionWarmup.target")(function* (
    threadId: ThreadId,
    includeDeleted: boolean,
  ) {
    const records = yield* projections.getThreadRecords(threadId, ["runs", "providerThreads"]);
    const thread = records.thread;
    if (
      (thread.deletedAt !== null && !includeDeleted) ||
      records.runs.length > 0 ||
      records.providerThreads.length > 0
    )
      return null;
    const instanceId = thread.modelSelection.instanceId;
    const capabilities = yield* (yield* adapters.get(instanceId)).getCapabilities();
    if (capabilities.sessions.supportsMultipleProviderThreadsPerSession) return null;
    return {
      thread,
      providerSessionId: idAllocator.derive.firstProviderSession({
        providerInstanceId: instanceId,
        threadId,
      }),
    };
  });

  const bestEffort =
    (operation: string) =>
    <E>(effect: Effect.Effect<void, E>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`provider session ${operation} ahead of the first message failed`, {
            cause,
          }),
        ),
      );

  const warm = Effect.fn("ProviderSessionWarmup.warm")(function* (threadId: ThreadId) {
    const found = yield* target(threadId, false);
    if (found === null) return;
    const policy = yield* runtimePolicy.resolve({
      thread: found.thread,
      modelSelection: found.thread.modelSelection,
    });
    yield* sessions.open({
      threadId,
      providerSessionId: found.providerSessionId,
      modelSelection: found.thread.modelSelection,
      runtimePolicy: policy,
      agentMcpRegistration: "canonical",
    });
  }, bestEffort("warm-up"));

  const release = Effect.fn("ProviderSessionWarmup.release")(function* (threadId: ThreadId) {
    const found = yield* target(threadId, true);
    if (found === null || !(yield* sessions.isLive(found.providerSessionId))) return;
    yield* sessions.close(found.providerSessionId);
  }, bestEffort("release"));

  return ProviderSessionWarmup.of({ warm, release });
});

export const layer = Layer.effect(ProviderSessionWarmup, make);
