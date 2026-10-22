import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentPolicySnapshot,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const savedModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
};
const policyModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-5-5",
};
const implementerModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-5-5",
};

const baseInput: ScheduledTaskUpsertInput = {
  title: "Triage",
  prompt: "Triage new issues.",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId: ProjectId.make("project:test"),
  workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
  modelSelection: savedModel,
  runtimeMode: "full-access",
  interactionMode: "default",
};

/** The service with a launcher that records each run's model, and optionally a role policy. */
const serviceLayer = (
  launched: Ref.Ref<ReadonlyArray<ModelSelection>>,
  policy: Layer.Layer<ManagedAgent.ManagedAgentService | ProviderRegistry.ProviderRegistry> | null,
) => {
  const deps = Layer.mergeAll(
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) =>
        Ref.update(launched, (all) => [...all, input.modelSelection]).pipe(
          Effect.as({ threadId: ThreadId.make("thread:run-1") } as never),
        ),
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
  );
  return ScheduledTaskService.layer.pipe(
    Layer.provide(policy === null ? deps : Layer.merge(deps, policy)),
  );
};

const policyLayer = Layer.mergeAll(
  Layer.mock(ManagedAgent.ManagedAgentService)({
    snapshot: () =>
      Effect.succeed({
        manifest: { roles: { "chore-worker": { taskClasses: ["non-ui"] } } },
      } as unknown as AgentPolicySnapshot),
    roles: () =>
      Effect.succeed({
        roles: [{ role: "chore-worker", selection: policyModel }],
      } as never),
  }),
  Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
);

it.effect("a task with a subagent role runs on the model its policy picks", () =>
  Effect.gen(function* () {
    const launched = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        ...baseInput,
        agentRole: "chore-worker",
        groupId: "group-1",
      });
      const { task: ran } = yield* service.runNow({ id: task.id });
      assert.deepEqual(yield* Ref.get(launched), [policyModel]);
      assert.equal(ran.lastRunStatus, "succeeded");
      const [stored] = (yield* service.list()).tasks;
      assert.equal(stored?.lastRunThreadId, "thread:run-1");

      // A caller that does not know the new fields keeps them.
      const { task: updated } = yield* service.upsert({
        ...baseInput,
        id: task.id,
        title: "Renamed",
      });
      assert.equal(updated.agentRole, "chore-worker");
      assert.equal(updated.groupId, "group-1");
    }).pipe(Effect.provide(serviceLayer(launched, policyLayer)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("without a role policy the task runs on its saved model", () =>
  Effect.gen(function* () {
    const launched = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({ ...baseInput, agentRole: "chore-worker" });
      yield* service.runNow({ id: task.id });
      assert.deepEqual(yield* Ref.get(launched), [savedModel]);
    }).pipe(Effect.provide(serviceLayer(launched, null)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a new task names the implementation-worker role when its caller names none", () =>
  Effect.gen(function* () {
    const launched = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(baseInput);
      assert.equal(task.agentRole, "implementation-worker");
      assert.deepEqual(yield* Ref.get(launched), []);
    }).pipe(Effect.provide(serviceLayer(launched, policyLayer)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const twoRolePolicyLayer = Layer.mergeAll(
  Layer.mock(ManagedAgent.ManagedAgentService)({
    snapshot: () =>
      Effect.succeed({
        manifest: {
          roles: {
            "chore-worker": { taskClasses: ["non-ui"] },
            "implementation-worker": { taskClasses: ["non-ui"] },
          },
        },
      } as unknown as AgentPolicySnapshot),
    roles: () =>
      Effect.succeed({
        roles: [
          { role: "chore-worker", selection: policyModel },
          { role: "implementation-worker", selection: implementerModel },
        ],
      } as never),
  }),
  Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
);

it.effect("editing a task's role moves its next run to that role's model", () =>
  Effect.gen(function* () {
    const launched = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({ ...baseInput, agentRole: "chore-worker" });
      yield* service.runNow({ id: task.id });
      assert.deepEqual(yield* Ref.get(launched), [policyModel]);

      // One edit to the task, not to any model, moves every later run.
      const { task: moved } = yield* service.upsert({
        ...baseInput,
        id: task.id,
        agentRole: "implementation-worker",
      });
      assert.equal(moved.agentRole, "implementation-worker");
      yield* service.runNow({ id: task.id });
      assert.deepEqual(yield* Ref.get(launched), [policyModel, implementerModel]);
    }).pipe(Effect.provide(serviceLayer(launched, twoRolePolicyLayer)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a caller that names only a model gets the default role, which picks the next run", () =>
  Effect.gen(function* () {
    const launched = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      // baseInput still carries savedModel, as an older client or an MCP caller would.
      const { task } = yield* service.upsert(baseInput);
      assert.equal(task.agentRole, "implementation-worker");
      yield* service.runNow({ id: task.id });
      assert.deepEqual(yield* Ref.get(launched), [implementerModel]);
    }).pipe(Effect.provide(serviceLayer(launched, twoRolePolicyLayer)));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
