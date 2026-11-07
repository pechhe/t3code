import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

// Released migrations keep their ids and names; later ones append to the manifest.
const RELEASED_FROM_48: ReadonlyArray<readonly [number, string]> = [
  [48, "ProjectionThreadBranchPullRequest"],
  [49, "ProjectionThreadsActiveOrderKey"],
  [50, "ProjectionThreadPullRequests"],
  [51, "ProjectionThreadMessageContext"],
  [52, "ProjectionThreadTitleState"],
  [53, "PullRequestFilesViewed"],
  [54, "ProjectionThreadsAutoSettleDisabledAt"],
  [55, "OrchestrationV2"],
  [56, "RemoveRedundantProjectionIndexes"],
  [57, "ScheduledTaskWebhooks"],
  [58, "WebhookRelayDeliveries"],
  [59, "McpAppModelContext"],
  [60, "ThreadSnapshotWindowIndexes"],
  [61, "PullRequestReviewGuides"],
  [62, "ThreadFailureLookupIndex"],
  [63, "Experiments"],
  [64, "AgentPolicySnapshots"],
  [65, "ExternalAgentWork"],
  [66, "ExperimentWork"],
  [67, "AdvisorConsultations"],
  [68, "ExperimentEvidence"],
  [69, "ScheduledTaskGroupsAndRoles"],
  [70, "AgentTaskHandoffs"],
  [71, "RunSetupRecords"],
  [72, "DropUnusedV1Projections"],
  [73, "ReleaseApprovals"],
  [74, "CanonicalizeThreadPullRequestLinks"],
  [75, "CodexUsageNativeTurnIndex"],
  [76, "RepairClientSettlementTimestamps"],
  [77, "ProjectHqRepositorySync"],
  [78, "BuildSendBackDeliveries"],
  [79, "WebhookDedupe"],
  [80, "ThreadCompactAt"],
  [81, "DropHandedWorkspaceAttachments"],
  [82, "BuildNoteDeliveries"],
  [83, "UnboundScheduledTaskDefaultWorkspace"],
  [84, "WorkspaceAllocationIntents"],
  [85, "BuildDecisionNotes"],
  [86, "ProjectHqUnregisteredKey"],
  [87, "ScheduledTaskRoleBackfill"],
  [88, "ShellStopRequestIndex"],
  [89, "HqForgeRecords"],
  [90, "ThreadMessageSearch"],
  [91, "ProjectionAggregateIndexes"],
  [92, "MaintenanceCandidateIndexes"],
  [93, "IntermediateEventCompaction"],
  [94, "EventLogWriteIndexes"],
  [95, "ProjectionReadIndexes"],
  [96, "Champions"],
  [97, "ChampionRecovery"],
  [98, "PeerLinks"],
  [99, "PeerLinkFence"],
  [100, "WaitingLinkRequestIndex"],
  [101, "ActiveTurnItemIndexes"],
  [102, "ExcludeAttachmentPlaceholdersFromSearch"],
  [103, "SubagentDeliveryState"],
  [104, "ProjectionProjectsPinArchive"],
  [105, "RepairBooleanSettledOverride"],
  [106, "DropOrchestrationEventCorrelationIndex"],
  [107, "DelegatedRecoveryIndexes"],
  [108, "WeaveStoredNames"],
  [109, "ChampionInvestigations"],
  [110, "ExperimentAssignmentThreads"],
  [111, "ScheduledTaskThreadMode"],
];

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("055_OrchestrationV2", (it) => {
  it.effect("upgrades released schema 53 through the latest migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      assert.deepStrictEqual<ReadonlyArray<readonly [number, string]>>(
        migrationManifest.filter(([id]) => id >= 48).slice(0, RELEASED_FROM_48.length),
        RELEASED_FROM_48,
      );

      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed,
        migrationManifest.filter(([id]) => id > 53),
      );
      assert.deepStrictEqual(yield* runMigrations(), []);

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 48
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        migrations,
        migrationManifest
          .filter(([id]) => id >= 48)
          .map(([migration_id, name]) => ({ migration_id, name })),
      );

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'orchestration_v2_projection_threads',
            'orchestration_v2_projection_subagents',
            'orchestration_v2_effect_outbox',
            'orchestration_v2_turn_item_positions',
            'orchestration_v2_projection_metadata',
            'orchestration_v2_projection_provider_session_bindings',
            'orchestration_v2_thread_launch_workflows',
            'orchestration_v2_legacy_imports',
            'scheduled_tasks'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map(({ name }) => name),
        [
          "orchestration_v2_effect_outbox",
          "orchestration_v2_legacy_imports",
          "orchestration_v2_projection_metadata",
          "orchestration_v2_projection_provider_session_bindings",
          "orchestration_v2_projection_subagents",
          "orchestration_v2_projection_threads",
          "orchestration_v2_thread_launch_workflows",
          "orchestration_v2_turn_item_positions",
          "scheduled_tasks",
        ],
      );

      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_events)
      `;
      const receiptColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_command_receipts)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_threads)
      `;
      const subagentColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_subagents)
      `;
      assert.ok(eventColumns.some(({ name }) => name === "application_event_version"));
      assert.ok(receiptColumns.some(({ name }) => name === "command_type"));
      assert.ok(threadColumns.some(({ name }) => name === "provider_instance_id"));
      assert.ok(subagentColumns.some(({ name }) => name === "driver"));
      assert.ok(subagentColumns.some(({ name }) => name === "provider_instance_id"));

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_orchestration_events_application_high_water',
            'orchestration_events_v2_created_threads_idx',
            'orchestration_v2_projection_turn_items_shell_pending_idx'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map(({ name }) => name),
        [
          "idx_orchestration_events_application_high_water",
          "orchestration_events_v2_created_threads_idx",
          "orchestration_v2_projection_turn_items_shell_pending_idx",
        ],
      );
    }),
  );
});
