import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  DEFAULT_SERVER_SETTINGS,
  FleetSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as ForgeWorkItems from "../hq/ForgeWorkItems.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as PeerEnvironments from "../peers/PeerEnvironments.ts";
import * as FleetPeers from "../peers/FleetPeers.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SlipJayLandings from "../project/SlipJayLandings.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as Settings from "../serverSettings.ts";
import * as FleetProjection from "./FleetProjection.ts";
import * as FleetSummaryService from "./FleetSummaryService.ts";

const localId = EnvironmentId.make("mac");
const peerId = EnvironmentId.make("vps");
const projectId = ProjectId.make("project-one");
const instance = ProviderInstanceId.make("codex");
const defaultSettings = DEFAULT_SERVER_SETTINGS;
const initial = DateTime.makeUnsafe("2026-10-19T12:00:00.000Z");
const isFleetSummary = Schema.is(FleetSummary);
const old = DateTime.subtract(initial, { days: 30 });

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const id = ThreadId.make(name);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId,
    title: name,
    providerInstanceId: instance,
    modelSelection: { instanceId: instance, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: old,
    updatedAt: old,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* store.apply({
    id: EventId.make(`create:${name}`),
    type: "thread.created",
    threadId: id,
    occurredAt: old,
    payload: thread,
  });
  return id;
});

const harness = Effect.gen(function* () {
  yield* TestClock.setTime(DateTime.toEpochMillis(initial));
  let online = true;
  let currentSettings = defaultSettings;
  let remote: FleetSummary = {
    cursor: "peer-cursor",
    environments: [
      {
        environmentId: peerId,
        label: "VPS",
        status: "available",
        observedAt: DateTime.formatIso(initial),
        lastSeenAt: DateTime.formatIso(initial),
        unavailableReason: null,
        threads: [],
        removedThreadIds: [],
        health: null,
      },
    ],
  };
  const calls: Array<Parameters<PeerEnvironments.PeerEnvironments["Service"]["callTool"]>[0]> = [];
  const service = yield* FleetSummaryService.FleetSummaryService.pipe(
    Effect.provide(
      FleetSummaryService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            FleetProjection.layer,
            FleetPeers.layer.pipe(
              Layer.provide(
                Layer.mock(PeerEnvironments.PeerEnvironments)({
                  stored: Effect.succeed([
                    { environmentId: peerId, label: "VPS", routes: [], linkedAt: old },
                  ]),
                  callTool: (input) =>
                    Effect.suspend(() => {
                      calls.push(input);
                      return online
                        ? Effect.succeed({ isError: false, text: "", structuredContent: remote })
                        : Effect.fail(
                            new PeerEnvironments.PeerCallError({
                              environmentId: peerId,
                              status: "offline",
                            }),
                          );
                    }),
                }),
              ),
            ),
            NodeCrypto.layer,
            Layer.mock(Environment.ServerEnvironment)({
              getDescriptor: Effect.succeed({
                environmentId: localId,
                label: "Mac",
                platform: { os: "darwin", arch: "arm64" },
                serverVersion: "test",
                capabilities: { repositoryIdentity: false },
              }),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () =>
                Effect.succeed([
                  {
                    id: projectId,
                    title: "Project one",
                    workspaceRoot: "/project",
                    repositoryIdentity: null,
                    defaultModelSelection: null,
                    defaultThreadEnvMode: null,
                    autoPull: false,
                    faviconPath: null,
                    projectIcon: null,
                    scripts: [],
                    createdAt: DateTime.formatIso(old),
                    updatedAt: DateTime.formatIso(old),
                  },
                ]),
            }),
            Layer.mock(ForgeWorkItems.ForgeWorkItems)({
              view: () =>
                Effect.succeed({
                  itemId: "item",
                  number: 153,
                  url: "https://hq.test/build/153",
                  readAt: DateTime.formatIso(initial),
                  unavailable: false,
                  item: { kind: "ticket", title: "Fleet", status: "ready", waits: [], holds: [] },
                }),
            }),
            Layer.mock(Settings.ServerSettingsService)({
              getSettings: Effect.sync(() => currentSettings),
            }),
            Layer.mock(HostResources.HostResources)({
              read: Effect.succeed({
                sampledAt: DateTime.toEpochMillis(initial),
                cpuUtilization: 0.2,
                cpuCount: 8,
                availableMemoryBytes: 100,
                totalMemoryBytes: 200,
              }),
            }),
            Layer.mock(SlipJayLandings.SlipJayLandings)({
              runner: Stream.make({
                connected: true,
                serial: [
                  {
                    operationId: "landing-one",
                    kind: "landing",
                    repo: "pechhe/t3code",
                    status: "running",
                    stage: "verifying",
                    submittedBy: "Mac",
                    submittedAt: DateTime.formatIso(DateTime.subtract(initial, { minutes: 5 })),
                    startedAt: DateTime.formatIso(DateTime.subtract(initial, { minutes: 1 })),
                  },
                ],
                deploy: [],
                deploys: [],
                paused: false,
              }),
              repositoryOf: () => Effect.succeed("pechhe/t3code"),
            }),
          ),
        ),
      ),
    ),
  );
  return {
    service,
    calls,
    offline: () => {
      online = false;
    },
    setRemote: (value: FleetSummary) => {
      remote = value;
    },
    setSettings: (value: typeof defaultSettings) => {
      currentSettings = value;
    },
  };
});

const layer = ProjectionStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect(
  "returns every project and peer row without transcript text, rolling descendants under parents",
  () =>
    Effect.gen(function* () {
      const { service, calls, setRemote } = yield* harness;
      const parent = yield* createThread("parent");
      yield* createThread("other-project", { projectId: ProjectId.make("project-two") });
      yield* createThread("child", {
        lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
      });
      yield* createThread("archived", { archivedAt: old });
      const local = yield* service.summary({}, { localOnly: true });
      setRemote({
        cursor: "remote-next",
        environments: [
          {
            ...local.environments[0]!,
            environmentId: peerId,
            label: "VPS",
            threads: Array.from({ length: 25 }, (_, index) => ({
              ...local.environments[0]!.threads[0]!,
              threadId: ThreadId.make(`peer-${index}`),
              environmentId: peerId,
              subagents: [],
            })),
          },
        ],
      });
      const result = yield* service.summary({});
      expect(result.environments[0]!.threads.map((row) => row.threadId)).toEqual([
        "other-project",
        parent,
      ]);
      expect(
        result.environments[0]!.threads.find((row) => row.threadId === parent)!.subagents.map(
          (row) => row.threadId,
        ),
      ).toEqual(["child"]);
      expect(result.environments[1]!.threads).toHaveLength(25);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.name).toBe("t3_fleet_summary");
      expect(JSON.stringify(result)).not.toContain("latestVisibleMessage");
      expect(isFleetSummary(result)).toBe(true);
    }).pipe(Effect.provide(layer)),
);

it.effect("reports a peer never seen answering as unavailable with no last-seen time", () =>
  Effect.gen(function* () {
    const { service, offline } = yield* harness;
    offline();
    const result = yield* service.summary({});
    expect(result.environments[1]).toMatchObject({
      environmentId: peerId,
      status: "unavailable",
      lastSeenAt: null,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps local rows and reports an offline peer with its last successful observation", () =>
  Effect.gen(function* () {
    const { service, offline } = yield* harness;
    yield* createThread("local");
    const first = yield* service.summary({});
    offline();
    yield* TestClock.adjust("1 second");
    const result = yield* service.summary({});
    expect(result.environments[0]!.threads).toHaveLength(1);
    expect(result.environments[1]).toMatchObject({
      environmentId: peerId,
      status: "unavailable",
      unavailableReason: "offline",
      lastSeenAt: first.environments[1]!.observedAt,
      threads: [],
      health: null,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "counts ten received messages per sender, excludes user and scheduled prompts, and detects window expiry",
  () =>
    Effect.gen(function* () {
      const { service } = yield* harness;
      const a = yield* createThread("a");
      const b = yield* createThread("b");
      const sql = yield* SqlClient.SqlClient;
      const insert = (
        id: string,
        recipient: ThreadId,
        sender: ThreadId | null,
        scheduled = false,
        createdAt = DateTime.formatIso(initial),
      ) => sql`
    INSERT INTO orchestration_v2_projection_messages
    (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
    VALUES (${id}, ${recipient}, 'user', 0, ${createdAt}, ${createdAt}, ${JSON.stringify({
      id,
      threadId: recipient,
      role: "user",
      senderThreadId: sender,
      ...(scheduled ? { scheduledTaskId: "scheduled" } : {}),
    })})
  `;
      for (let index = 0; index < 10; index++) {
        yield* insert(`a-${index}`, a, b);
        yield* insert(`b-${index}`, b, a);
      }
      yield* insert("user", a, null);
      yield* insert("scheduled", a, b, true);
      yield* insert("old", a, b, false, DateTime.formatIso(old));
      const first = yield* service.summary({}, { localOnly: true });
      expect(first.environments[0]!.threads.map((row) => row.receivedMessages)).toEqual([
        [{ senderThreadId: b, count: 10 }],
        [{ senderThreadId: a, count: 10 }],
      ]);
      const same = yield* service.summary({ changedSince: first.cursor }, { localOnly: true });
      expect(same.environments[0]!.threads).toHaveLength(0);
      yield* TestClock.adjust("61 minutes");
      const expired = yield* service.summary({ changedSince: same.cursor }, { localOnly: true });
      expect(expired.environments[0]!.threads.map((row) => row.receivedMessages)).toEqual([[], []]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "returns only changed parents including child changes and reports archived removals",
  () =>
    Effect.gen(function* () {
      const { service } = yield* harness;
      yield* createThread("unchanged");
      const parent = yield* createThread("parent");
      const child = yield* createThread("child", {
        lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
      });
      const first = yield* service.summary({}, { localOnly: true });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.title', 'changed child') WHERE thread_id = ${child}`;
      const changed = yield* service.summary({ changedSince: first.cursor }, { localOnly: true });
      expect(changed.environments[0]!.threads.map((row) => row.threadId)).toEqual([parent]);
      expect(changed.environments[0]!.threads[0]!.subagents[0]!.title).toBe("changed child");
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.archivedAt', ${DateTime.formatIso(initial)}) WHERE thread_id = ${parent}`;
      const archived = yield* service.summary(
        { changedSince: changed.cursor },
        { localOnly: true },
      );
      expect(archived.environments[0]!.removedThreadIds).toEqual([parent]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "leaves settled threads out and keeps a live subagent whose parent settled",
  () =>
    Effect.gen(function* () {
      const { service } = yield* harness;
      yield* createThread("live");
      yield* createThread("settled", { settledAt: old });
      yield* createThread("kept", { settledAt: old, settledOverride: "active" });
      yield* createThread("pinned-settled", { settledOverride: "settled" });
      const parent = yield* createThread("settled-parent", { settledAt: old });
      yield* createThread("orphan", {
        lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
      });
      const first = yield* service.summary({}, { localOnly: true });
      expect(first.environments[0]!.threads.map((row) => row.threadId).toSorted()).toEqual([
        "kept",
        "live",
        "orphan",
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "reports cached Build state, existing settlement rules, watches and health without transcript growth",
  () =>
    Effect.gen(function* () {
      const { service, setSettings } = yield* harness;
      setSettings({ ...defaultSettings, sidebarAutoSettleAfterDays: 1 });
      const due = yield* createThread("due", {
        workItem: { origin: "https://hq.test", itemId: "item", number: 153 },
      });
      const pinned = yield* createThread("pinned", { pinnedAt: old });
      yield* createThread("watcher", {
        threadWatches: [
          {
            id: "watch",
            target: { kind: "thread", threadId: due },
            title: "due",
            startedAt: DateTime.formatIso(old),
          },
          {
            id: "build-watch",
            target: { kind: "build_item", number: 152, until: "closed" },
            title: "Build #152",
            startedAt: DateTime.formatIso(old),
          },
        ],
      });
      const sql = yield* SqlClient.SqlClient;
      for (const thread of [due, pinned])
        yield* sql`
    INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
    VALUES (${`old-${thread}`}, ${thread}, 'user', 0, ${DateTime.formatIso(old)}, ${DateTime.formatIso(old)}, '{}')
  `;
      yield* sql`
    INSERT INTO release_approvals (approval_id, repository, candidate, base, summary_json, details, status, requested_at, updated_at)
    VALUES ('approval', 'pechhe/t3code', 'candidate', 'base', ${JSON.stringify({ verification: { status: "passed" } })}, 'private approval details', 'pending', ${DateTime.formatIso(old)}, ${DateTime.formatIso(old)})
  `;
      const first = yield* service.summary({}, { localOnly: true });
      const source = first.environments[0]!;
      expect(source.threads.find((row) => row.threadId === due)).toMatchObject({
        forgeItem: {
          number: 153,
          status: "ready",
          waitsAndHoldsClear: true,
          unavailable: false,
          observedAt: DateTime.formatIso(initial),
        },
        settlement: { eligible: true, reason: "automatic_settlement_due" },
      });
      expect(source.threads.find((row) => row.threadId === pinned)?.settlement).toEqual({
        eligible: false,
        reason: "pinned",
      });
      expect(source.threads.find((row) => row.threadId === "watcher")?.watches).toEqual([
        { kind: "thread", threadId: due, startedAt: DateTime.formatIso(old) },
        { kind: "build_item", number: 152, until: "closed", startedAt: DateTime.formatIso(old) },
      ]);
      expect(source.health?.landings.projects[0]?.operations[0]).toMatchObject({
        stage: "verifying",
        queuedForMs: 240_000,
        runningForMs: 60_000,
      });
      expect(source.health?.releases.approvals).toEqual([
        {
          approvalId: "approval",
          repository: "pechhe/t3code",
          candidate: "candidate",
          candidateStatus: "passed",
          candidateObservedAt: DateTime.formatIso(old),
        },
      ]);
      expect(source.health?.host.sample.cpuUtilization).toBe(0.2);
      const transcript = "PRIVATE TRANSCRIPT".repeat(100_000);
      yield* sql`
    INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
    VALUES ('history', ${due}, 'assistant', 0, ${DateTime.formatIso(old)}, ${DateTime.formatIso(old)}, ${JSON.stringify({ text: transcript })})
  `;
      const after = yield* service.summary({}, { localOnly: true });
      expect(after.environments[0]!.threads).toEqual(source.threads);
      expect(JSON.stringify(after)).not.toContain("PRIVATE TRANSCRIPT");
      expect(JSON.stringify(after)).not.toContain("private approval details");
    }).pipe(Effect.provide(layer)),
);

it.effect("rejects malformed and wrong-environment cursors", () =>
  Effect.gen(function* () {
    const { service } = yield* harness;
    const invalid = yield* service.summary({ changedSince: "invalid" }).pipe(Effect.flip);
    expect(invalid.reason).toBe("invalid_cursor");
    const wrong = yield* service
      .summary({
        changedSince: JSON.stringify({ version: 1, environmentId: peerId, rows: {}, peers: {} }),
      })
      .pipe(Effect.flip);
    expect(wrong.reason).toBe("invalid_cursor");
  }).pipe(Effect.provide(layer)),
);
