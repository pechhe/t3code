import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { EventId, ProjectId, type ApplicationProjectEvent } from "@t3tools/contracts";
import { deriveProjectIdentity } from "@t3tools/shared/projectIdentity";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { planProjectCommand } from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";
import * as HqRepositories from "./HqRepositories.ts";
import * as RepositoryChipSync from "./RepositoryChipSync.ts";

const projectId = ProjectId.make("chip-sync");
const now = "2026-10-20T12:00:00.000Z";
const base = {
  eventId: EventId.make("chip-event"),
  aggregateKind: "project" as const,
  aggregateId: projectId,
  occurredAt: now,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

const harness = Effect.gen(function* () {
  const store = yield* ProjectStore.ProjectStoreV2;
  let sequence = 1;
  yield* store.apply({
    ...base,
    sequence,
    type: "project.created",
    payload: {
      projectId,
      title: "YardSmith",
      workspaceRoot: "/work/yardsmith",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  let linked = true;
  let connected = true;
  let failed = false;
  let repository: HqRepositories.Repository | undefined;
  const pushes: Array<Parameters<HqRepositories.HqRepositories["Service"]["setRepository"]>[0]> =
    [];
  const edit = (
    payload: Omit<
      Extract<ApplicationProjectEvent, { type: "project.meta-updated" }>["payload"],
      "projectId" | "updatedAt"
    >,
  ) =>
    store.apply({
      ...base,
      sequence: ++sequence,
      type: "project.meta-updated",
      payload: { projectId, updatedAt: now, ...payload },
    });
  const sync = yield* RepositoryChipSync.RepositoryChipSync.pipe(
    Effect.provide(
      RepositoryChipSync.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(HqAgentConnections.HqAgentConnections)({
              read: Effect.sync(() =>
                connected ? { origin: "https://hq.test", connection: "connection-one" } : null,
              ),
              connectionChanges: Stream.empty,
            }),
            Layer.mock(HqRepositories.HqRepositories)({
              listRepositories: () =>
                failed
                  ? Effect.fail(
                      new HqRepositories.HqRepositoryError({ operation: "list", cause: "offline" }),
                    )
                  : Effect.sync(() => (repository ? [repository] : [])),
              setRepository: (input) =>
                Effect.sync(() => {
                  pushes.push(input);
                  repository = {
                    key: input.key,
                    name: "YardSmith",
                    aliases: [],
                    colour: input.colour,
                    icon: input.icon,
                    revision: (repository?.revision ?? 0) + 1,
                    updatedAt: now,
                    updatedSource: "t3",
                  };
                  return repository;
                }),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getShell: (id) =>
                store.getShell(id).pipe(
                  Effect.map(
                    Option.map((shell) => ({
                      ...shell,
                      repositoryIdentity: linked
                        ? {
                            canonicalKey: "github.com/pechhe/yardsmith",
                            locator: {
                              source: "git-remote" as const,
                              remoteName: "origin",
                              remoteUrl: "https://github.com/pechhe/yardsmith.git",
                            },
                          }
                        : null,
                    })),
                  ),
                  Effect.orDie,
                ),
              recordHqSync: (input) =>
                Effect.gen(function* () {
                  const row = Option.getOrThrow(yield* store.get(projectId));
                  const event = Result.getOrThrow(
                    planProjectCommand({
                      command: {
                        type: "project.meta.update",
                        commandId: input.commandId,
                        projectId,
                        expectedSyncState: input.expected,
                        hqSyncedRevision: input.revision,
                        hqSyncedValueHash: input.valueHash,
                        ...(input.projectIcon === undefined
                          ? {}
                          : { projectIcon: input.projectIcon }),
                      },
                      state: { project: row, workspaceOwner: undefined },
                      eventId: base.eventId,
                      now: DateTime.makeUnsafe(now),
                    }),
                  );
                  yield* store.apply({ ...event, sequence: ++sequence });
                }).pipe(Effect.orDie),
            }),
          ),
        ),
      ),
    ),
  );
  return {
    sync: sync.sync,
    edit,
    pushes,
    row: store.get(projectId).pipe(Effect.map(Option.getOrThrow)),
    hqHas: (value: HqRepositories.Repository) => {
      repository = value;
    },
    setLinked: (value: boolean) => {
      linked = value;
    },
    disconnect: () => {
      connected = false;
    },
    fail: () => {
      failed = true;
    },
    changeHq: () => {
      repository = {
        ...repository!,
        revision: repository!.revision + 1,
        colour: "rose",
        icon: { kind: "emoji", emoji: "🌹" },
        updatedSource: "hq",
      };
    },
  };
});

const testLayer = Layer.mergeAll(ProjectStore.layer, OrchestrationEventStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeCrypto.layer),
);

it.layer(testLayer)("RepositoryChipSync", (it) => {
  it.effect("seeds HQ from the derived colour and monogram, then stays quiet", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.sync;
      const identity = deriveProjectIdentity("YardSmith");
      assert.deepEqual(h.pushes, [
        {
          key: "pechhe/yardsmith",
          name: "YardSmith",
          colour: identity.color,
          icon: { kind: "monogram", text: identity.monogram },
        },
      ]);
      assert.equal((yield* h.row).hqSyncedRevision, 1);
      yield* h.sync;
      assert.lengthOf(h.pushes, 1);
    }),
  );
  it.effect("a project with no baseline adopts an HQ record someone already edited", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.hqHas({
        key: "pechhe/yardsmith",
        name: "YardSmith",
        aliases: [],
        colour: "rose",
        icon: { kind: "monogram", text: "YSX" },
        revision: 4,
        updatedAt: "2026-10-20T12:00:00.000Z",
        updatedSource: "hq",
      });
      yield* h.sync;
      assert.lengthOf(h.pushes, 0);
      const row = yield* h.row;
      assert.equal(row.hqSyncedRevision, 4);
      assert.deepEqual(row.projectIcon, { kind: "monogram", text: "YS", color: "rose" });
    }),
  );

  it.effect("pulls newer HQ values and does not echo the pulled override", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.sync;
      h.changeHq();
      yield* h.sync;
      assert.deepEqual((yield* h.row).projectIcon, { kind: "emoji", emoji: "🌹", color: "rose" });
      assert.equal((yield* h.row).hqSyncedRevision, 2);
      yield* h.sync;
      assert.lengthOf(h.pushes, 1);
    }),
  );
  it.effect("pushes a local edit even when HQ also changed", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.sync;
      h.changeHq();
      yield* h.edit({ projectIcon: { kind: "emoji", emoji: "🦊", color: "orange" } });
      yield* h.sync;
      assert.equal(h.pushes.at(-1)?.colour, "orange");
      assert.deepEqual(h.pushes.at(-1)?.icon, { kind: "emoji", emoji: "🦊" });
      assert.equal((yield* h.row).hqSyncedRevision, 3);
    }),
  );
  it.effect("a project matched through an alias pushes to the record it matched", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.hqHas({
        key: "pechhe/weave",
        name: "Weave",
        aliases: ["pechhe/yardsmith"],
        colour: "rose",
        icon: { kind: "monogram", text: "WV" },
        revision: 2,
        updatedAt: "2026-10-20T12:00:00.000Z",
        updatedSource: "hq",
      });
      yield* h.sync;
      yield* h.edit({ projectIcon: { kind: "emoji", emoji: "🦊", color: "orange" } });
      yield* h.sync;
      assert.equal(h.pushes.at(-1)?.key, "pechhe/weave");
    }),
  );
  it.effect("skips local-only projects in both directions", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.edit({ hqSyncLocalOnly: true });
      yield* h.sync;
      assert.isEmpty(h.pushes);
      yield* h.edit({ hqSyncLocalOnly: false });
      yield* h.sync;
      h.changeHq();
      yield* h.edit({ hqSyncLocalOnly: true });
      yield* h.sync;
      assert.isNull((yield* h.row).projectIcon);
    }),
  );
  it.effect("skips an unlinked project, but uses an explicit link without a remote", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.setLinked(false);
      yield* h.sync;
      assert.isEmpty(h.pushes);
      yield* h.edit({ hqRepositoryKey: "pechhe/manual" });
      yield* h.sync;
      assert.equal(h.pushes[0]?.key, "pechhe/manual");
    }),
  );
  it.effect("offline and disconnected HQ never fail project work", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.fail();
      yield* h.sync;
      yield* h.edit({ title: "Still editable" });
      assert.equal((yield* h.row).title, "Still editable");
      h.disconnect();
      yield* h.sync;
      assert.isEmpty(h.pushes);
      assert.isNull((yield* h.row).hqSyncedRevision);
    }),
  );
});
