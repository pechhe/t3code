import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AgentTaskBinding,
  CheckpointScopeId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

it.effect("refreshes workspace after checkpoint capture without reading history", () => {
  const threadId = ThreadId.make("thread_finalize");
  const runId = RunId.make("run_finalize");
  const scopeId = CheckpointScopeId.make("scope_finalize");
  const capture = vi.fn(() => Effect.void);
  const refresh = vi.fn(() => Effect.void);
  const checkpointContext = {
    runs: [],
    checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
    checkpoints: [],
  };
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: capture }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () =>
            Effect.die("workspace refresh must not load transcript history"),
          getCheckpointContext: () => Effect.succeed(checkpointContext),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          recordHandoff: () => Effect.void,
          refreshAfterTurn: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.equal(capture.mock.calls.length, 1);
    assert.deepEqual(refresh.mock.calls[0], [{ cwd: "/repo", threadId, runId }]);
  }).pipe(Effect.provide(layer));
});

it.effect.each(
  (
    [
      {
        label: "discovers a new PR for the completed run's branch",
        branch: "feature",
        checkedOut: "feature",
        activeRun: null,
        expected: ["/repo"],
      },
      {
        label: "leaves the default branch's PR cache alone",
        branch: "main",
        checkedOut: "main",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh another thread's checkout",
        branch: "feature",
        checkedOut: "other",
        activeRun: null,
        expected: [],
      },
      {
        label: "does not refresh during a newer active run",
        branch: "feature",
        checkedOut: "feature",
        activeRun: "newer-run",
        expected: [],
      },
    ] as const
  ).map((scenario) => [scenario.label, scenario] as const),
)("%s", ([, scenario]) => {
  const refreshed: string[] = [];
  const threadId = ThreadId.make("thread-pr-refresh");
  const runId = RunId.make("completed-run");
  const layer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({
          refreshAfterTurn: () => Effect.void,
        }),
        Layer.mock(ManagedAgent.ManagedAgentService)({}),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: scenario.checkedOut === "main",
              refName: scenario.checkedOut,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () =>
            Effect.die("turn completion must preserve known PRs and lookup backoff"),
          refreshPullRequestStatus: (cwd) =>
            Effect.sync(() => {
              refreshed.push(cwd);
              return null;
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              branch: scenario.branch,
              activeRunId: scenario.activeRun === null ? null : RunId.make(scenario.activeRun),
            } as OrchestrationV2ThreadShell),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const observer = yield* RunFinalization.RunFinalizationObserver;
    yield* observer.refresh({ cwd: "/repo", threadId, runId });
    assert.deepEqual(refreshed, [...scenario.expected]);
  }).pipe(Effect.provide(layer));
});

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
        NodeServices.layer,
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
