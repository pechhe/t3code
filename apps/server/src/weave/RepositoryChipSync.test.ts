import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  type CommandId,
  EventId,
  ProjectId,
  type ApplicationProjectEvent,
} from "@t3tools/contracts";
import { deriveProjectIdentity } from "@t3tools/shared/projectIdentity";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { planProjectCommand, type ProjectCommand } from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as WeaveAgentConnections from "./WeaveAgentConnections.ts";
import * as WeaveRepositories from "./WeaveRepositories.ts";
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
  // Weave lists a repository only once a person registered it.
  let repository: WeaveRepositories.Repository | undefined = {
    key: "pechhe/yardsmith",
    name: "yardsmith",
    aliases: [],
    colour: "amber",
    icon: { kind: "monogram" as const, text: "YA" },
    revision: 1,
    updatedAt: now,
    updatedSource: "registered",
  };
  const pushes: Array<
    Parameters<WeaveRepositories.WeaveRepositories["Service"]["setRepository"]>[0]
  > = [];
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
  const record = (
    commandId: CommandId,
    expected: ProjectStore.ProjectRow,
    fields: Partial<Extract<ProjectCommand, { type: "project.meta.update" }>>,
  ) =>
    Effect.gen(function* () {
      const row = Option.getOrThrow(yield* store.get(projectId));
      const event = Result.getOrThrow(
        planProjectCommand({
          command: {
            type: "project.meta.update",
            commandId,
            projectId,
            expectedSyncState: expected,
            ...fields,
          },
          state: { project: row, workspaceOwner: undefined },
          eventId: base.eventId,
          now: DateTime.makeUnsafe(now),
        }),
      );
      yield* store.apply({ ...event, sequence: ++sequence });
    }).pipe(Effect.orDie);
  const sync = yield* RepositoryChipSync.RepositoryChipSync.pipe(
    Effect.provide(
      RepositoryChipSync.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(WeaveAgentConnections.WeaveAgentConnections)({
              read: Effect.sync(() =>
                connected ? { origin: "https://weave.test", connection: "connection-one" } : null,
              ),
              connectionChanges: Stream.empty,
            }),
            Layer.mock(WeaveRepositories.WeaveRepositories)({
              listRepositories: () =>
                failed
                  ? Effect.fail(
                      new WeaveRepositories.WeaveRepositoryError({
                        operation: "list",
                        cause: "offline",
                      }),
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
              recordWeaveSync: (input) =>
                record(input.commandId, input.expected, {
                  weaveSyncedRevision: input.revision,
                  weaveSyncedValueHash: input.valueHash,
                  ...(input.projectIcon === undefined ? {} : { projectIcon: input.projectIcon }),
                }),
              recordWeaveUnregistered: (input) =>
                record(input.commandId, input.expected, { weaveUnregisteredKey: input.key }),
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
    registered: repository!,
    weaveHas: (value: WeaveRepositories.Repository) => {
      repository = value;
    },
    setLinked: (value: boolean) => {
      linked = value;
    },
    disconnect: () => {
      connected = false;
    },
    reconnect: () => {
      connected = true;
    },
    fail: () => {
      failed = true;
    },
    changeWeave: () => {
      repository = {
        ...repository!,
        revision: repository!.revision + 1,
        colour: "rose",
        icon: { kind: "emoji" as const, emoji: "🌹" },
        updatedSource: "weave",
      };
    },
  };
});

const testLayer = Layer.mergeAll(ProjectStore.layer, OrchestrationEventStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeCrypto.layer),
);

it.layer(testLayer)("RepositoryChipSync", (it) => {
  it.effect("seeds Weave from the derived colour and monogram, then stays quiet", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.sync;
      const identity = deriveProjectIdentity("YardSmith");
      assert.deepEqual(h.pushes, [
        {
          key: "pechhe/yardsmith",
          colour: identity.color,
          icon: { kind: "monogram" as const, text: identity.monogram },
        },
      ]);
      assert.equal((yield* h.row).weaveSyncedRevision, 2);
      yield* h.sync;
      assert.lengthOf(h.pushes, 1);
    }),
  );
  it.effect("a project with no baseline adopts a Weave record someone already edited", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.weaveHas({
        key: "pechhe/yardsmith",
        name: "YardSmith",
        aliases: [],
        colour: "rose",
        icon: { kind: "monogram" as const, text: "YSX" },
        revision: 4,
        updatedAt: "2026-10-20T12:00:00.000Z",
        updatedSource: "weave",
      });
      yield* h.sync;
      assert.lengthOf(h.pushes, 0);
      const row = yield* h.row;
      assert.equal(row.weaveSyncedRevision, 4);
      assert.deepEqual(row.projectIcon, { kind: "monogram", text: "YS", color: "rose" });
    }),
  );

  it.effect(
    "a project with no baseline pushes its look over a repository Weave only registered",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        h.weaveHas({
          key: "pechhe/yardsmith",
          name: "yardsmith",
          aliases: [],
          colour: "amber",
          icon: { kind: "monogram" as const, text: "YA" },
          revision: 1,
          updatedAt: "2026-10-20T12:00:00.000Z",
          updatedSource: "registered",
        });
        yield* h.edit({ projectIcon: { kind: "lucide", name: "server", color: "violet" } });
        yield* h.sync;
        assert.deepEqual(h.pushes.at(-1)?.icon, { kind: "lucide", name: "server" });
        assert.equal(h.pushes.at(-1)?.colour, "violet");
        assert.equal((yield* h.row).weaveSyncedRevision, 2);
      }),
  );
  // The first sync against a recorded snapshot of T3 project looks: Weave ends up with each one.
  it.effect.each([
    {
      override: { kind: "lucide" as const, name: "server", color: "violet" as const },
      colour: "violet" as const,
      icon: { kind: "lucide" as const, name: "server" },
    },
    {
      override: { kind: "emoji" as const, emoji: "🚀", color: "orange" as const },
      colour: "orange" as const,
      icon: { kind: "emoji" as const, emoji: "🚀" },
    },
    {
      override: { kind: "monogram" as const, text: "YS", color: "teal" as const },
      colour: "teal" as const,
      icon: { kind: "monogram" as const, text: "YS" },
    },
  ])("first sync gives Weave the recorded look of a project: %#", (recorded) =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.edit({ projectIcon: recorded.override });
      yield* h.sync;
      assert.deepEqual(h.pushes, [
        {
          key: "pechhe/yardsmith",
          colour: recorded.colour,
          icon: recorded.icon,
        },
      ]);
    }),
  );
  it.effect("pulls newer Weave values and does not echo the pulled override", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.sync;
      h.changeWeave();
      yield* h.sync;
      assert.deepEqual((yield* h.row).projectIcon, { kind: "emoji", emoji: "🌹", color: "rose" });
      assert.equal((yield* h.row).weaveSyncedRevision, 3);
      yield* h.sync;
      assert.lengthOf(h.pushes, 1);
    }),
  );
  it.effect("pushes a local edit even when Weave also changed", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.sync;
      h.changeWeave();
      yield* h.edit({ projectIcon: { kind: "emoji", emoji: "🦊", color: "orange" } });
      yield* h.sync;
      assert.equal(h.pushes.at(-1)?.colour, "orange");
      assert.deepEqual(h.pushes.at(-1)?.icon, { kind: "emoji", emoji: "🦊" });
      assert.equal((yield* h.row).weaveSyncedRevision, 4);
    }),
  );
  it.effect("a project matched through an alias pushes to the record it matched", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.weaveHas({
        key: "pechhe/weave",
        name: "Weave",
        aliases: ["pechhe/yardsmith"],
        colour: "rose",
        icon: { kind: "monogram" as const, text: "WV" },
        revision: 2,
        updatedAt: "2026-10-20T12:00:00.000Z",
        updatedSource: "weave",
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
      yield* h.edit({ weaveSyncLocalOnly: true });
      yield* h.sync;
      assert.isEmpty(h.pushes);
      yield* h.edit({ weaveSyncLocalOnly: false });
      yield* h.sync;
      h.changeWeave();
      yield* h.edit({ weaveSyncLocalOnly: true });
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
      yield* h.edit({ weaveRepositoryKey: "pechhe/manual" });
      yield* h.sync;
      assert.isEmpty(h.pushes, "Weave lists no pechhe/manual, so there is nothing to sync");
      assert.equal((yield* h.row).weaveUnregisteredKey, "pechhe/manual");
      h.disconnect();
      yield* h.sync;
      assert.equal(
        (yield* h.row).weaveUnregisteredKey,
        "pechhe/manual",
        "kept while Weave is unreachable",
      );
      h.reconnect();
      h.weaveHas({ ...h.registered, key: "pechhe/manual" });
      yield* h.sync;
      assert.equal(h.pushes[0]?.key, "pechhe/manual");
      assert.isNull((yield* h.row).weaveUnregisteredKey);
    }),
  );
  it.effect("clears the unregistered mark when the link is cleared or kept local", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.edit({ weaveRepositoryKey: "pechhe/manual" });
      yield* h.sync;
      assert.equal((yield* h.row).weaveUnregisteredKey, "pechhe/manual");
      yield* h.edit({ weaveSyncLocalOnly: true });
      yield* h.sync;
      assert.isNull((yield* h.row).weaveUnregisteredKey);
      yield* h.edit({ weaveSyncLocalOnly: false });
      yield* h.sync;
      assert.equal((yield* h.row).weaveUnregisteredKey, "pechhe/manual");
      yield* h.edit({ weaveRepositoryKey: null });
      yield* h.sync;
      assert.isNull((yield* h.row).weaveUnregisteredKey);
    }),
  );
  it.effect("offline and disconnected Weave never fail project work", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.fail();
      yield* h.sync;
      yield* h.edit({ title: "Still editable" });
      assert.equal((yield* h.row).title, "Still editable");
      h.disconnect();
      yield* h.sync;
      assert.isEmpty(h.pushes);
      assert.isNull((yield* h.row).weaveSyncedRevision);
    }),
  );
});
