import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ReleaseApprovalId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { threadShellFromProjection } from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Release approval shell tests do not run provider turns"),
};
const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "release-approval-shell" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

it.layer(layer)("release approval shell", (it) => {
  it.effect("shows each open card on the thread shell until it is answered", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("release-approval-shell");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-release-approval-shell"),
        threadId,
        projectId: ProjectId.make("release-approval-project"),
        title: "Release lead",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("ask-release"),
        threadId,
        messageId: MessageId.make("ask-release"),
        text: "Release it.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const card = {
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        turnItemId: TurnItemId.make("turn-item:release-approval:shell"),
        approvalId: ReleaseApprovalId.make("release-approval:shell"),
        repository: "pechhe/yardsmith",
        candidate: "a".repeat(40),
        base: "b".repeat(40),
        summary: {
          commits: 2,
          items: [],
          migrations: [],
          verification: { status: "passed" as const },
          coveredByEarlierApproval: false,
        },
        details: "Two commits.",
      };
      yield* orchestrator.dispatch({
        type: "release_approval.record",
        commandId: CommandId.make("record-release-pending"),
        ...card,
        approvalStatus: "pending",
      });
      // A lead releasing two repositories waits on one card for each.
      const other = {
        ...card,
        turnItemId: TurnItemId.make("turn-item:release-approval:shell-other"),
        approvalId: ReleaseApprovalId.make("release-approval:shell-other"),
        repository: "pechhe/t3code",
      };
      yield* orchestrator.dispatch({
        type: "release_approval.record",
        commandId: CommandId.make("record-other-release-pending"),
        ...other,
        approvalStatus: "pending",
      });

      const open = (yield* orchestrator.getThreadShell(threadId))?.pendingReleaseApprovals;
      assert.deepStrictEqual(
        open?.map((entry) => entry.approvalId),
        [card.approvalId, other.approvalId],
      );
      assert.strictEqual(open?.[0]?.candidate, card.candidate);
      assert.deepStrictEqual(
        threadShellFromProjection(yield* orchestrator.getThreadProjection(threadId))
          .pendingReleaseApprovals,
        open,
      );
      // The owner answers through ReleaseApprovals, never an agent's pending-request tools.
      assert.isNull((yield* orchestrator.getThreadShell(threadId))?.pendingRuntimeRequest ?? null);

      yield* orchestrator.dispatch({
        type: "release_approval.record",
        commandId: CommandId.make("record-release-approved"),
        ...card,
        approvalStatus: "approved",
        answer: {
          decision: "approved",
          candidate: card.candidate,
          note: null,
          answeredBy: "owner",
          answeredAt: "2026-10-18T12:00:00.000Z",
        },
      });
      assert.deepStrictEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pendingReleaseApprovals?.map(
          (entry) => entry.approvalId,
        ),
        [other.approvalId],
      );
    }),
  );
});
