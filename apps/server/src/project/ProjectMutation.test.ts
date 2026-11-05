import { assert, describe, expect, it } from "@effect/vitest";
import { CommandId, type Project, ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { projectMutationOperation } from "./ProjectMutation.ts";
import { type ProjectService } from "./ProjectService.ts";
import * as Fiber from "effect/Fiber";

import { ProjectNotEmptyError } from "./ProjectService.ts";
import { mutateProjectWithClone } from "./ProjectMutation.ts";

const projectId = ProjectId.make("project-1");
const deletedProject: Project = {
  id: projectId,
  title: "kh-frontend",
  workspaceRoot: "/workspace/kh-frontend",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: "2026-01-01T00:00:00.000Z",
};

describe("mutateProjectWithClone", () => {
  it.effect("keeps the clone when deletion is rejected", () =>
    Effect.gen(function* () {
      const rejected = new ProjectNotEmptyError({ projectId });
      const result = yield* mutateProjectWithClone(
        {
          create: () => Effect.die("unused"),
          update: () => Effect.die("unused"),
          delete: () => Effect.fail(rejected),
        },
        { discard: () => Effect.die("must not discard a project that still exists") },
        { type: "project.delete", commandId: CommandId.make("rejected-delete"), projectId },
      ).pipe(Effect.flip);

      expect(result).toBe(rejected);
    }),
  );

  it.effect("discards the clone record even when the caller disconnects mid-delete", () =>
    Effect.gen(function* () {
      const committed = yield* Deferred.make<void>();
      const finishDelete = yield* Deferred.make<void>();
      const discarded: Array<ProjectId> = [];
      const projects = {
        create: () => Effect.die("unused"),
        update: () => Effect.die("unused"),
        // The delete event is already durable while its post-commit cleanup runs.
        delete: () =>
          Deferred.succeed(committed, undefined).pipe(
            Effect.andThen(Deferred.await(finishDelete)),
            Effect.as(deletedProject),
          ),
      };
      const clones = {
        discard: (id: ProjectId) => Effect.sync(() => void discarded.push(id)),
      };

      const request = yield* mutateProjectWithClone(projects, clones, {
        type: "project.delete",
        commandId: CommandId.make("command-1"),
        projectId,
      }).pipe(Effect.forkChild);
      yield* Deferred.await(committed);
      // Delivered synchronously so it lands before the delete can finish.
      request.interruptUnsafe();
      yield* Deferred.succeed(finishDelete, undefined);
      yield* Fiber.await(request);

      expect(discarded).toEqual([projectId]);
    }),
  );
});

describe("fork project mutation mapping", () => {
  const projectId = ProjectId.make("project:mutation-mapping");
  const project = {
    id: projectId,
    title: "Mapping",
    workspaceRoot: "/work/mapping",
    repositoryIdentity: null,
    faviconPath: null,
    projectIcon: null,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    weaveRepositoryKey: null,
    weaveSyncLocalOnly: false,
    scripts: [],
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    deletedAt: null,
  } satisfies Project;

  it.effect("preserves every project mutation field", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const projects: Pick<ProjectService["Service"], "create" | "delete" | "update"> = {
        create: (input) =>
          Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
        update: (input) =>
          Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
        delete: (input) =>
          Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      };

      yield* projectMutationOperation(projects, {
        type: "project.create",
        commandId: CommandId.make("command:create"),
        projectId,
        title: "Created",
        workspaceRoot: "/work/created",
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
        scripts: [],
      });
      yield* projectMutationOperation(projects, {
        type: "project.update",
        commandId: CommandId.make("command:update"),
        projectId,
        title: "Updated",
        workspaceRoot: "/work/updated",
        defaultModelSelection: null,
        autoPull: false,
        weaveRepositoryKey: null,
        weaveSyncLocalOnly: false,
        projectIcon: null,
        faviconPath: null,
        defaultThreadEnvMode: null,
        scripts: [],
      });
      yield* projectMutationOperation(projects, {
        type: "project.delete",
        commandId: CommandId.make("command:delete"),
        projectId,
        force: true,
      });

      assert.deepEqual(yield* Ref.get(calls), [
        {
          commandId: "command:create",
          projectId,
          title: "Created",
          workspaceRoot: "/work/created",
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: null,
          scripts: [],
        },
        {
          commandId: "command:update",
          projectId,
          title: "Updated",
          workspaceRoot: "/work/updated",
          defaultModelSelection: null,
          autoPull: false,
          weaveRepositoryKey: null,
          weaveSyncLocalOnly: false,
          projectIcon: null,
          faviconPath: null,
          defaultThreadEnvMode: null,
          scripts: [],
        },
        { commandId: "command:delete", projectId, force: true },
      ]);
    }),
  );
});

describe("projectMutationOperation Weave names", () => {
  const update = (fields: Record<string, unknown>) =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
      yield* projectMutationOperation(
        {
          create: () => Effect.die("unused"),
          delete: () => Effect.die("unused"),
          update: (input) =>
            Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(deletedProject)),
        },
        {
          type: "project.update",
          commandId: CommandId.make("command:weave"),
          projectId,
          ...fields,
        } as never,
      );
      return (yield* Ref.get(calls))[0];
    });

  it.effect("applies the names an older fork client sends", () =>
    Effect.gen(function* () {
      expect(
        yield* update({ hqRepositoryKey: "pechhe/yardsmith", hqSyncLocalOnly: true }),
      ).toMatchObject({ weaveRepositoryKey: "pechhe/yardsmith", weaveSyncLocalOnly: true });
      expect(yield* update({ hqRepositoryKey: null })).toMatchObject({ weaveRepositoryKey: null });
    }),
  );

  it.effect("keeps a current client's clear and false over anything retained", () =>
    Effect.gen(function* () {
      expect(
        yield* update({
          weaveRepositoryKey: null,
          weaveSyncLocalOnly: false,
          hqRepositoryKey: "stale/key",
          hqSyncLocalOnly: true,
        }),
      ).toMatchObject({ weaveRepositoryKey: null, weaveSyncLocalOnly: false });
    }),
  );
});
