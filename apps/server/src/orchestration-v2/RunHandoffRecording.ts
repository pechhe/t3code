import type { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ManagedAgent from "../agents/ManagedAgentService.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";

export interface RunHandoffRecordingDeps {
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  readonly managed: ManagedAgent.ManagedAgentService["Service"];
}

export const make = ({ projections, managed }: RunHandoffRecordingDeps) =>
  Effect.fn("RunFinalizationService.recordHandoff")(
    function* ({ threadId, runId }: { readonly threadId: ThreadId; readonly runId: RunId }) {
      const thread = yield* projections.getThreadShell(threadId);
      if (!thread?.agentTask) return;
      // A run that already gave way to another has nothing left to read.
      if (thread.activeRunId !== null && thread.activeRunId !== runId) return;
      yield* managed.recordHandoff(thread.agentTask, { threadId, runId });
    },
    (effect, { threadId, runId }) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to record a handoff revision after run completion", {
            threadId,
            runId,
            detail: error.message,
          }),
        ),
      ),
  );
