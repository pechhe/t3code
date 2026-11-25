import * as ContextManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ChampionId,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const baseInput: ScheduledTaskUpsertInput = {
  title: "Triage",
  prompt: "Triage new issues.",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId: ProjectId.make("project:test"),
  workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

const serviceLayer = ScheduledTaskService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        isNonGitProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        isProviderInstanceEnabledForProject: () => Effect.succeed(true),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      NodeCrypto.layer,
      Scheduler.layer,
    ),
  ),
);

it.effect("a task keeps its Champion until a save names another or clears it", () =>
  Effect.gen(function* () {
    const service = yield* ScheduledTaskService.ScheduledTaskService;
    const watch = ChampionId.make("watch");
    const { task } = yield* service.upsert({ ...baseInput, championId: watch });
    assert.equal(task.championId, watch);
    // An older client or an agent update that does not know the field.
    const { task: renamed } = yield* service.upsert({
      ...baseInput,
      id: task.id,
      title: "Renamed",
    });
    assert.equal(renamed.championId, watch);
    const listed = (yield* service.list()).tasks.find((candidate) => candidate.id === task.id);
    assert.equal(listed?.championId, watch);
    const { task: cleared } = yield* service.upsert({
      ...baseInput,
      id: task.id,
      championId: null,
    });
    assert.equal(cleared.championId, null);
    const { task: plain } = yield* service.upsert({ ...baseInput, title: "Other" });
    assert.equal(plain.championId, null);
  }).pipe(
    Effect.provide(
      serviceLayer.pipe(
        Layer.provideMerge(
          SqlitePersistence.layerMemory.pipe(Layer.provideMerge(ContextManagedPolicy.layerTest())),
        ),
      ),
    ),
  ),
);
