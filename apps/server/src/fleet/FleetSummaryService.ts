import {
  FleetSummary,
  type FleetSummaryInput,
  FleetThreadSummary,
  type FleetEnvironmentSummary,
  ReleaseVerificationStatus,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as BuildWorkItems from "../hq/BuildWorkItems.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  isAutoSettlementCandidate,
  isSnoozed,
  resolveAutoSettlementAt,
  threadHasQueuedTurnStart,
} from "../orchestration-v2/ThreadSettlementService.ts";
import * as FleetPeers from "../peers/FleetPeers.ts";
import * as SlipJayLandings from "../project/SlipJayLandings.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as Settings from "../serverSettings.ts";
import * as FleetProjection from "./FleetProjection.ts";

const Cursor = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: Schema.String,
  rows: Schema.Record(Schema.String, Schema.String),
  peers: Schema.Record(
    Schema.String,
    Schema.Struct({ cursor: Schema.String, lastSeenAt: Schema.String }),
  ),
});
type Cursor = typeof Cursor.Type;
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor));
const encodeCursor = Schema.encodeEffect(Schema.fromJsonString(Cursor));
const encodeThread = Schema.encodeEffect(Schema.fromJsonString(FleetThreadSummary));
const isVerificationStatus = Schema.is(ReleaseVerificationStatus);
const timestampMs = (value: string | undefined) =>
  value === undefined
    ? null
    : Option.getOrNull(Option.map(DateTime.make(value), DateTime.toEpochMillis));
export class FleetSummaryError extends Schema.TaggedError<FleetSummaryError>()(
  "FleetSummaryError",
  {
    reason: Schema.Literals(["invalid_cursor", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.reason === "invalid_cursor"
      ? "Invalid fleet summary cursor for this environment."
      : "The fleet summary could not be read.";
  }
}
const failure = (cause: unknown) => new FleetSummaryError({ reason: "unavailable", cause });

export class FleetSummaryService extends Context.Service<
  FleetSummaryService,
  {
    readonly summary: (
      input: FleetSummaryInput,
      options?: { readonly localOnly: boolean },
    ) => Effect.Effect<FleetSummary, FleetSummaryError>;
  }
>()("t3/fleet/FleetSummaryService") {}

const make = Effect.gen(function* () {
  const environment = yield* Environment.ServerEnvironment;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const build = yield* BuildWorkItems.BuildWorkItems;
  const settings = yield* Settings.ServerSettingsService;
  const fleetProjection = yield* FleetProjection.FleetProjection;
  const landings = yield* SlipJayLandings.SlipJayLandings;
  const host = yield* HostResources.HostResources;
  const peers = yield* FleetPeers.FleetPeers;
  const crypto = yield* Crypto.Crypto;
  const lastSeen = new Map<string, string>();

  const summary: FleetSummaryService["Service"]["summary"] = Effect.fn(
    "FleetSummaryService.summary",
  )(function* (input, options) {
    const descriptor = yield* environment.getDescriptor;
    let previous: Cursor | undefined;
    if (input.changedSince !== undefined) {
      previous = yield* decodeCursor(input.changedSince).pipe(
        Effect.mapError((cause) => new FleetSummaryError({ reason: "invalid_cursor", cause })),
      );
      if (previous.environmentId !== descriptor.environmentId) {
        return yield* new FleetSummaryError({ reason: "invalid_cursor" });
      }
    }
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const observedAt = DateTime.formatIso(now);
    const [snapshot, projectShells, candidates, currentSettings, releases] = yield* Effect.all([
      projections.getShellSnapshot({ location: "active" }),
      projects.listShells(),
      projections.getSettlementCandidates(),
      settings.getSettings,
      fleetProjection.releases,
    ]).pipe(Effect.mapError(failure));
    // Settled threads are finished work; hundreds of them would bury the live ones and bloat the cursor.
    const threads = snapshot.threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        thread.settledOverride !== "settled" &&
        (thread.settledOverride === "active" || thread.settledAt === null),
    );
    const threadIds = threads.map((thread) => thread.id);
    const [counts, requests] = yield* Effect.all([
      fleetProjection.messageCounts(nowMs, threadIds),
      fleetProjection.pendingRequests(threadIds),
    ]).pipe(Effect.mapError(failure));
    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const projectById = new Map(projectShells.map((project) => [project.id, project]));
    const requestsById = new Map(requests.map((request) => [request.threadId, request.count]));
    const messagesById = Map.groupBy(counts, (message) => message.threadId);
    const baseRows = yield* Effect.forEach(
      threads,
      (thread) =>
        Effect.gen(function* () {
          const cached =
            thread.workItem == null
              ? null
              : yield* build.view(thread.id).pipe(Effect.orElseSucceed(() => null));
          const pendingRequestCount = Math.max(
            requestsById.get(thread.id) ?? 0,
            (thread.pendingRuntimeRequest === null ? 0 : 1) +
              (thread.pendingReleaseApprovals?.length ?? 0),
          );
          const projectSettings = resolveProjectSettings(
            currentSettings,
            thread.projectId,
          ).settings;
          const candidate = candidateById.get(thread.id);
          const settlementInput = candidate ?? {
            ...thread,
            latestUserAuthoredMessageAt: thread.latestUserAuthoredMessageAt ?? null,
            lastSnoozeWakeAt: null,
          };
          const eligible =
            candidate !== undefined &&
            resolveAutoSettlementAt({
              thread: candidate,
              pullRequest: null,
              nowMs,
              autoSettleAfterDays: projectSettings.sidebarAutoSettleAfterDays,
              autoSettleOnMerge: projectSettings.sidebarAutoSettleOnMerge,
              autoSettleKeepPullRequests: projectSettings.sidebarAutoSettleKeepPullRequests,
            }) !== null;
          const reason = eligible
            ? "automatic_settlement_due"
            : !isAutoSettlementCandidate(settlementInput, nowMs)
              ? thread.settledOverride === "active"
                ? "explicitly_kept_active"
                : thread.settledOverride === "settled"
                  ? "explicitly_settled"
                  : thread.pinnedAt != null
                    ? "pinned"
                    : thread.autoSettleDisabledAt != null
                      ? "automatic_settlement_disabled"
                      : thread.pendingRuntimeRequest !== null
                        ? "pending_person_request"
                        : thread.activityRunStatus != null
                          ? "run_in_progress"
                          : threadHasQueuedTurnStart(thread, nowMs)
                            ? "turn_start_queued"
                            : isSnoozed(settlementInput, nowMs)
                              ? "snoozed"
                              : "background_work_holds_completion"
              : (thread.linkedPullRequest != null || thread.branchPullRequest != null) &&
                  (thread.pullRequests?.length ?? 0) === 0
                ? "pull_request_status_not_observed"
                : "automatic_settlement_not_due";
          const prs = visibleThreadPullRequests(thread.pullRequests ?? []);
          const times = [
            thread.updatedAt,
            thread.latestUserMessageAt,
            thread.latestRunRequestedAt,
            thread.latestRunStartedAt,
            thread.latestRunCompletedAt,
            thread.latestVisibleMessage?.updatedAt,
          ]
            .filter((time) => time != null)
            .map(DateTime.toEpochMillis);
          return {
            threadId: thread.id,
            title: thread.title,
            project: {
              id: thread.projectId,
              title: projectById.get(thread.projectId)?.title ?? thread.projectId,
            },
            environmentId: descriptor.environmentId,
            workflow: thread.workflow ?? null,
            parentThreadId: thread.lineage.parentThreadId,
            relationshipToParent: thread.lineage.relationshipToParent,
            buildItem:
              thread.workItem == null
                ? null
                : {
                    number: thread.workItem.number,
                    ref: cached?.item?.ref ?? null,
                    status: cached?.item?.status ?? null,
                    waitsAndHoldsClear:
                      cached?.item == null
                        ? null
                        : cached.item.waits.length === 0 && cached.item.holds.length === 0,
                    unavailable: cached?.unavailable ?? true,
                    observedAt: cached?.readAt ?? null,
                  },
            runState:
              pendingRequestCount > 0
                ? ("waiting_on_person" as const)
                : (thread.activeRunId !== null &&
                      (thread.status === "preparing" || thread.status === "starting")) ||
                    thread.activityRunStatus === "preparing" ||
                    thread.activityRunStatus === "starting" ||
                    threadHasQueuedTurnStart(thread, nowMs)
                  ? ("queued" as const)
                  : thread.activeRunId !== null || thread.activityRunStatus != null
                    ? ("running" as const)
                    : ("idle" as const),
            pendingRequestCount,
            lastActivityAt: DateTime.formatIso(DateTime.makeUnsafe(Math.max(...times))),
            watches: [
              ...(thread.threadWatches ?? []).map((watch) => ({
                ...watch.target,
                startedAt: watch.startedAt,
              })),
              ...prs
                .filter((pr) => pr.watch !== undefined)
                .map((pr) => ({
                  kind: "pull_request" as const,
                  url: pr.url,
                  startedAt: pr.watch!.startedAt,
                })),
            ],
            pullRequests: prs.map((pr) => ({ url: pr.url, state: pr.snapshot?.state ?? null })),
            snoozed: isSnoozed(settlementInput, nowMs),
            settlement: { eligible, reason },
            receivedMessages: (messagesById.get(thread.id) ?? []).map(
              ({ senderThreadId, count }) => ({ senderThreadId, count }),
            ),
          } satisfies FleetThreadSummary["subagents"][number];
        }),
      { concurrency: 8 },
    );
    const byId = new Map(baseRows.map((row) => [row.threadId, row]));
    const children = new Map<ThreadId, Array<FleetThreadSummary["subagents"][number]>>();
    const roots: typeof baseRows = [];
    for (const row of baseRows) {
      let parent = row;
      const visited = new Set<ThreadId>([row.threadId]);
      while (parent.relationshipToParent === "subagent" && parent.parentThreadId !== null) {
        const ancestor = byId.get(parent.parentThreadId);
        if (ancestor === undefined || visited.has(ancestor.threadId)) break;
        visited.add(ancestor.threadId);
        parent = ancestor;
      }
      if (parent === row) roots.push(row);
      else children.set(parent.threadId, [...(children.get(parent.threadId) ?? []), row]);
    }
    const rows = roots.map((row) => ({ ...row, subagents: children.get(row.threadId) ?? [] }));
    const hashes = Object.fromEntries(
      yield* Effect.forEach(rows, (row) =>
        encodeThread(row).pipe(
          Effect.flatMap((encoded) => crypto.digest("SHA-256", new TextEncoder().encode(encoded))),
          Effect.map((hash) => [row.threadId, Hex.encode(hash)] as const),
          Effect.mapError(failure),
        ),
      ),
    );
    const overview = yield* Stream.runHead(landings.runner);
    const runner = Option.getOrElse(overview, () => ({
      connected: false,
      serial: [],
      deploy: [],
      deploys: [],
      paused: false,
    }));
    const landingProjects = (yield* Effect.forEach(
      projectShells,
      (project) =>
        landings.repositoryOf(project.workspaceRoot).pipe(
          Effect.map((repository) =>
            repository === null
              ? null
              : {
                  projectId: project.id,
                  repository,
                  operations: runner.serial
                    .filter(
                      (operation) => operation.repo === repository && operation.kind === "landing",
                    )
                    .map((operation) => {
                      const submitted = timestampMs(operation.submittedAt);
                      const started = timestampMs(operation.startedAt);
                      return {
                        ...operation,
                        queuedForMs:
                          submitted === null
                            ? null
                            : started !== null
                              ? Math.max(0, started - submitted)
                              : operation.status === "queued"
                                ? Math.max(0, nowMs - submitted)
                                : null,
                        runningForMs:
                          started === null || operation.status !== "running"
                            ? null
                            : Math.max(0, nowMs - started),
                      };
                    }),
                },
          ),
        ),
      { concurrency: 8 },
    )).filter((project) => project !== null);
    const sample = yield* host.read;
    const local: FleetEnvironmentSummary = {
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      status: "available",
      observedAt,
      lastSeenAt: observedAt,
      unavailableReason: null,
      threads: rows.filter((row) => previous?.rows[row.threadId] !== hashes[row.threadId]),
      removedThreadIds: Object.keys(previous?.rows ?? {})
        .filter((id) => hashes[id] === undefined)
        .map((id) => ThreadId.make(id)),
      health: {
        landings: { observedAt, connected: runner.connected, projects: landingProjects },
        releases: {
          observedAt,
          approvals: releases.map((release) => ({
            ...release,
            candidateStatus: isVerificationStatus(release.candidateStatus)
              ? release.candidateStatus
              : null,
          })),
        },
        host: { observedAt: DateTime.formatIso(DateTime.makeUnsafe(sample.sampledAt)), sample },
      },
    };
    const nextPeers: Record<string, Cursor["peers"][string]> = {};
    const environments: Array<FleetEnvironmentSummary> = [local];
    if (!options?.localOnly) {
      const answers = yield* peers
        .read(
          Object.fromEntries(
            Object.entries(previous?.peers ?? {}).map(([id, peer]) => [id, peer.cursor]),
          ),
        )
        .pipe(Effect.mapError(failure));
      for (const answer of answers) {
        const remote = answer.summary?.environments.find(
          (source) =>
            source.environmentId === answer.environmentId && source.status === "available",
        );
        if (remote !== undefined && answer.summary !== null) {
          environments.push(remote);
          lastSeen.set(answer.environmentId, remote.observedAt);
          nextPeers[answer.environmentId] = {
            cursor: answer.summary.cursor,
            lastSeenAt: remote.observedAt,
          };
        } else {
          const previousPeer = previous?.peers[answer.environmentId];
          if (previousPeer !== undefined) nextPeers[answer.environmentId] = previousPeer;
          environments.push({
            environmentId: answer.environmentId,
            label: answer.label,
            status: "unavailable",
            observedAt,
            // Never seen answering since this server started or the caller's cursor: unknown, not its link time.
            lastSeenAt:
              lastSeen.get(answer.environmentId) ??
              previous?.peers[answer.environmentId]?.lastSeenAt ??
              null,
            unavailableReason: answer.reason ?? "unsupported",
            threads: [],
            removedThreadIds: [],
            health: null,
          });
        }
      }
    }
    const cursor = yield* encodeCursor({
      version: 1,
      environmentId: descriptor.environmentId,
      rows: hashes,
      peers: nextPeers,
    }).pipe(Effect.mapError(failure));
    return { environments, cursor };
  });
  return FleetSummaryService.of({ summary });
});
export const layer = Layer.effect(FleetSummaryService, make);
