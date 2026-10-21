import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

/**
 * Moves a live provider session to a thread's new compact-at point when it changes, for
 * providers that can take it mid-session. Other sessions pick the point up when they next
 * open, from the thread, so nothing is faked for them.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const apply = Effect.fn("ThreadCompactAtService.apply")(
    function* (threadId: ThreadId, compactAt: number | null) {
      const { thread, providerThreads } = yield* projections.getThreadRecords(threadId, [
        "providerThreads",
      ]);
      const providerThread = providerThreads.find(
        (candidate) => candidate.id === thread.activeProviderThreadId,
      );
      if (providerThread?.providerSessionId == null) return;
      const session = yield* sessions.get(providerThread.providerSessionId);
      if (Option.isNone(session) || session.value.setCompactAt === undefined) return;
      yield* session.value.setCompactAt({ providerThread, compactAt });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("compact-at change not applied to the live session", {
            threadId,
            cause,
          }),
        ),
      ),
  );

  const start = Effect.fn("ThreadCompactAtService.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "thread.compact-at-set"
          ? apply(event.threadId, event.payload.compactAt ?? null)
          : Effect.void,
      ),
    );
  });
  return { start };
});
