import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";
import { SlipJayRunnerOperation } from "./git.ts";
import { ReleaseVerificationStatus } from "./releaseApproval.ts";
import { OrchestrationV2ThreadWorkflow } from "./orchestrationV2.ts";

export const FleetSummaryInput = Schema.Struct({
  /** Opaque cursor returned by the previous sweep; omit for a full snapshot. */
  changedSince: Schema.optionalKey(Schema.String),
});
export type FleetSummaryInput = typeof FleetSummaryInput.Type;

export const FleetWatch = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId, startedAt: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("pull_request"),
    url: Schema.String,
    startedAt: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("build_item"),
    number: Schema.Number,
    until: Schema.Literals(["unblocked", "closed"]),
    startedAt: Schema.String,
  }),
]);

const ThreadFields = {
  threadId: ThreadId,
  title: Schema.String,
  project: Schema.Struct({ id: ProjectId, title: Schema.String }),
  environmentId: EnvironmentId,
  workflow: Schema.NullOr(OrchestrationV2ThreadWorkflow),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  buildItem: Schema.NullOr(
    Schema.Struct({
      number: Schema.Number,
      /** The friendly ref such as `YS-12` when Build has told T3 one; absent from older servers. */
      ref: Schema.optionalKey(Schema.NullOr(Schema.String)),
      status: Schema.NullOr(Schema.String),
      waitsAndHoldsClear: Schema.NullOr(Schema.Boolean),
      unavailable: Schema.Boolean,
      observedAt: Schema.NullOr(Schema.String),
    }),
  ),
  runState: Schema.Literals(["running", "queued", "idle", "waiting_on_person"]),
  pendingRequestCount: Schema.Number,
  lastActivityAt: Schema.String,
  watches: Schema.Array(FleetWatch),
  pullRequests: Schema.Array(
    Schema.Struct({ url: Schema.String, state: Schema.NullOr(Schema.String) }),
  ),
  snoozed: Schema.Boolean,
  settlement: Schema.Struct({ eligible: Schema.Boolean, reason: Schema.String }),
  receivedMessages: Schema.Array(Schema.Struct({ senderThreadId: ThreadId, count: Schema.Number })),
};
export const FleetThreadSummary = Schema.Struct({
  ...ThreadFields,
  /** Descendants roll up under the nearest included ancestor, never as top-level rows. */
  subagents: Schema.Array(Schema.Struct(ThreadFields)),
});
export type FleetThreadSummary = typeof FleetThreadSummary.Type;

export const FleetEnvironmentSummary = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  status: Schema.Literals(["available", "unavailable"]),
  observedAt: Schema.String,
  lastSeenAt: Schema.NullOr(Schema.String),
  unavailableReason: Schema.NullOr(Schema.String),
  threads: Schema.Array(FleetThreadSummary),
  /** IDs removed since the cursor, including archived and newly settled threads. */
  removedThreadIds: Schema.Array(ThreadId),
  health: Schema.NullOr(
    Schema.Struct({
      landings: Schema.Struct({
        observedAt: Schema.String,
        connected: Schema.Boolean,
        projects: Schema.Array(
          Schema.Struct({
            projectId: ProjectId,
            repository: Schema.String,
            operations: Schema.Array(
              Schema.Struct({
                ...SlipJayRunnerOperation.fields,
                queuedForMs: Schema.NullOr(Schema.Number),
                runningForMs: Schema.NullOr(Schema.Number),
              }),
            ),
          }),
        ),
      }),
      releases: Schema.Struct({
        observedAt: Schema.String,
        approvals: Schema.Array(
          Schema.Struct({
            approvalId: Schema.String,
            repository: Schema.String,
            candidate: Schema.String,
            candidateStatus: Schema.NullOr(ReleaseVerificationStatus),
            candidateObservedAt: Schema.String,
          }),
        ),
      }),
      host: Schema.Struct({ observedAt: Schema.String, sample: HostResourcesSnapshot }),
    }),
  ),
});
export type FleetEnvironmentSummary = typeof FleetEnvironmentSummary.Type;
export const FleetSummary = Schema.Struct({
  cursor: Schema.String,
  environments: Schema.Array(FleetEnvironmentSummary),
});
export type FleetSummary = typeof FleetSummary.Type;
