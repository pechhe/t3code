import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import {
  type AgentTaskBinding,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

// Without a project the observer never touches enrichment, so its methods stay unimplemented.
const layerNoProject = Layer.mergeAll(
  Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
);

it.effect.each([
  { label: "keeps what a finished helper handed back", activeRun: null, revision: "helper-commit" },
  { label: "records nothing once a newer run is active", activeRun: "newer-run", revision: null },
] as const)("$label", ({ activeRun, revision }) => {
  const threadId = ThreadId.make("helper-thread");
  const runId = RunId.make("completed-run");
  const binding = {
    workspacePath: "/helper",
    workspaceAssignment: "isolated",
    sourceAccess: "scoped-write",
  } as AgentTaskBinding;
  // What `jj log -r @` reports in the helper's workspace.
  const workingCopy = { revision: "helper-commit" };
  const managed = ManagedAgent.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Sqlite.layerMemory,
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.sync(() => ({
              stdout: `${workingCopy.revision}\n`,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            })),
        }),
      ),
    ),
  );
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerNoProject,
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
        Layer.mock(PullRequestService.PullRequestService)({}),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              agentTask: binding,
              activeRunId: activeRun === null ? null : RunId.make(activeRun),
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
    Layer.provideMerge(managed),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    const service = yield* ManagedAgent.ManagedAgentService;
    yield* observer.recordHandoff({ threadId, runId });
    // The lead reuses the workspace before reading the finished task's status.
    workingCopy.revision = "later-commit";
    yield* observer.recordHandoff({ threadId, runId });
    assert.equal((yield* service.handoff(binding, { threadId, runId }))?.revision, revision);
  }).pipe(Effect.provide(layer));
});
