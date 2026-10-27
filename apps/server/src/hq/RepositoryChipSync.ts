import { CommandId, type ProjectIconOverride } from "@t3tools/contracts";
import { deriveProjectIdentity, weaveRepositoryKeyOf } from "@t3tools/shared/projectIdentity";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";
import * as HqRepositories from "./HqRepositories.ts";

function effectiveValue(project: {
  readonly title: string;
  readonly projectIcon?: ProjectIconOverride | null;
}) {
  const derived = deriveProjectIdentity(project.title);
  const icon = project.projectIcon;
  return {
    colour: icon?.color ?? derived.color,
    icon:
      icon?.kind === "emoji"
        ? { kind: "emoji" as const, emoji: icon.emoji }
        : icon?.kind === "lucide"
          ? { kind: "lucide" as const, name: icon.name }
          : { kind: "monogram" as const, text: icon?.text ?? derived.monogram },
  };
}

export class RepositoryChipSync extends Context.Service<
  RepositoryChipSync,
  {
    readonly sync: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/hq/RepositoryChipSync") {}

const make = Effect.gen(function* () {
  const weave = yield* HqRepositories.HqRepositories;
  const connections = yield* HqAgentConnections.HqAgentConnections;
  const projects = yield* ProjectService.ProjectService;
  const store = yield* ProjectStore.ProjectStoreV2;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const lock = yield* Semaphore.make(1);
  const crypto = yield* Crypto.Crypto;
  const sync = Effect.gen(function* () {
    const connection = yield* connections.read;
    if (connection === null) return;
    const repositories = new Map(
      (yield* weave.listRepositories()).map((repository) => [repository.key, repository]),
    );
    for (const listed of yield* store.list()) {
      yield* Effect.gen(function* () {
        const shell = yield* projects.getShell(listed.projectId);
        if (shell._tag === "None") return;
        const key = weaveRepositoryKeyOf(shell.value);
        const matched =
          key === null
            ? undefined
            : (repositories.get(key) ??
              [...repositories.values()].find((record) => record.aliases.includes(key)));
        // Only a person registers a repository, so a key Weave does not list is never pushed (it would
        // only be refused); a hand link to one is recorded so settings can say why it is not synced.
        const unregistered =
          !listed.hqSyncLocalOnly && !matched && listed.hqRepositoryKey
            ? listed.hqRepositoryKey
            : null;
        let row = listed;
        if ((listed.hqUnregisteredKey ?? null) !== unregistered) {
          yield* projects.recordHqUnregistered({
            commandId: CommandId.make(`hq-repository-unregistered:${yield* crypto.randomUUIDv4()}`),
            expected: listed,
            key: unregistered,
          });
          const updated = yield* store.get(listed.projectId);
          if (updated._tag === "None") return;
          row = updated.value;
        }
        if (row.hqSyncLocalOnly || key === null || !matched) return;
        const local = effectiveValue(row);
        const hash = (value: ReturnType<typeof effectiveValue>) =>
          crypto
            .digest("SHA-256", new TextEncoder().encode(JSON.stringify({ key, ...value })))
            .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
        const localHash = yield* hash(local);
        let repository = matched;
        let projectIcon: ProjectIconOverride | undefined;
        // A project with no baseline adopts a Weave server record someone has already edited; with no such
        // record (none, or one only registered with its default look) it establishes its own value
        // once. After that a local edit is pushed and Weave stamps it on receipt, so the later receipt
        // wins; a newer Weave revision is pulled.
        const unedited = repository?.updatedSource === "registered";
        const unsynced = (row.hqSyncedValueHash ?? null) === null;
        const adopt = () => {
          projectIcon = {
            ...(repository.icon.kind === "monogram"
              ? { ...repository.icon, text: Array.from(repository.icon.text).slice(0, 2).join("") }
              : repository.icon),
            color: repository.colour,
          };
        };
        if (!unedited && unsynced) {
          adopt();
        } else if (row.hqSyncedValueHash !== localHash) {
          // A project matched through an alias edits the record it matched, not a new one.
          repository = yield* weave.setRepository({
            key: repository.key,
            ...local,
          });
          repositories.set(repository.key, repository);
        } else if (repository.revision > (row.hqSyncedRevision ?? 0)) {
          adopt();
        } else return;
        // A reconnect during the request must not persist a baseline for the old Weave.
        const current = yield* connections.read;
        if (current?.connection !== connection.connection) return;
        const valueHash = yield* hash(
          projectIcon ? effectiveValue({ title: row.title, projectIcon }) : local,
        );
        const commandId = yield* crypto.randomUUIDv4();
        yield* projects.recordHqSync({
          commandId: CommandId.make(`hq-repository-sync:${commandId}`),
          expected: row,
          revision: repository.revision,
          valueHash,
          ...(projectIcon === undefined ? {} : { projectIcon }),
        });
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("Could not sync a project's HQ repository chip", {
            projectId: listed.projectId,
          }),
        ),
      );
    }
  }).pipe(
    lock.withPermit,
    Effect.catch(() =>
      Effect.logWarning("Could not sync HQ repository chips; retrying on next tick"),
    ),
    Effect.withSpan("RepositoryChipSync.sync"),
  );
  const start = Effect.fn("RepositoryChipSync.start")(function* () {
    const afterSequence = yield* events.latestApplicationSequence.pipe(
      Effect.orElseSucceed(() => 0),
    );
    yield* forkParked(sync.pipe(Effect.repeat(Schedule.spaced("5 minutes"))));
    yield* forkParked(Stream.runForEach(connections.connectionChanges, () => sync));
    yield* forkParked(
      events.streamApplicationEvents({ afterSequence }).pipe(
        Stream.filter(
          (event) =>
            "aggregateKind" in event &&
            (event.type === "project.created" ||
              (event.type === "project.meta-updated" &&
                event.payload.hqSyncedRevision === undefined &&
                event.payload.hqUnregisteredKey === undefined &&
                (event.payload.projectIcon !== undefined ||
                  event.payload.hqRepositoryKey !== undefined ||
                  event.payload.hqSyncLocalOnly !== undefined ||
                  event.payload.title !== undefined ||
                  event.payload.workspaceRoot !== undefined))),
        ),
        Stream.runForEach(() => sync),
        Effect.catch(() => Effect.logWarning("HQ repository chip event stream stopped")),
      ),
    );
  });
  return RepositoryChipSync.of({ sync, start });
});

export const layer = Layer.effect(RepositoryChipSync, make);
