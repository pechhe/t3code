import { assert, it } from "@effect/vitest";
import {
  type AgentTaskBinding,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as ServerSettings from "../serverSettings.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const grokInstanceId = ProviderInstanceId.make("grok");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const layerTest = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      listPools: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
  ),
);

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("uses the project root for local-checkout threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-root");
    }),
  );

  it.effect("prefers a provisioned worktree over the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
    }),
  );

  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );
});

const managedBinding: AgentTaskBinding = {
  role: "ticket-reviewer",
  taskClass: "non-ui",
  workId: "runtime-work",
  attemptId: "runtime-attempt",
  workspacePath: "/managed-worktree",
  sourceRevision: "pinned-source",
  requestFingerprint: "a".repeat(64),
  policyHash: "b".repeat(64),
  policyRevision: "policy-runtime",
  briefHash: "c".repeat(64),
  sourceAccess: "read-only",
  toolProfile: "source-reader",
  requested: modelSelection,
  assigned: null,
  effective: modelSelection,
};

it.layer(layerTest)("managed RuntimePolicyV2", (it) => {
  it.effect("fails closed when the managed validation guard is absent", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const failure = yield* policy
        .resolve({
          thread: {
            ...makeThread({ now, worktreePath: managedBinding.workspacePath }),
            agentTask: managedBinding,
          },
          modelSelection,
        })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "RuntimePolicyResolveError");
    }),
  );

  it.effect("propagates managed validation refusal before returning a runtime policy", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const cause = new ManagedAgent.ManagedAgentError({ reason: "revoked" });
      const failure = yield* policy
        .resolve({
          thread: {
            ...makeThread({ now, worktreePath: managedBinding.workspacePath }),
            agentTask: managedBinding,
          },
          modelSelection,
        })
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerSettings.layerTest(),
              Layer.mock(ManagedAgent.ManagedAgentService)({ validate: () => Effect.fail(cause) }),
            ),
          ),
          Effect.flip,
        );
      assert.equal(failure._tag, "RuntimePolicyResolveError");
      assert.strictEqual(failure.cause, cause);
    }),
  );

  it.effect("keeps approved managed review read-only with exact cwd under full access", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const validations: Array<
        Parameters<ManagedAgent.ManagedAgentService["Service"]["validate"]>[0]
      > = [];
      const result = yield* policy
        .resolve({
          thread: {
            ...makeThread({
              now,
              worktreePath: managedBinding.workspacePath,
              runtimeMode: "full-access",
            }),
            interactionMode: "plan",
            agentTask: managedBinding,
          },
          modelSelection,
        })
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerSettings.layerTest(),
              Layer.mock(ManagedAgent.ManagedAgentService)({
                validate: (value) =>
                  Effect.sync(() => {
                    validations.push(value);
                  }),
              }),
            ),
          ),
        );
      assert.lengthOf(validations, 1);
      assert.equal(validations[0]?.workspacePath, managedBinding.workspacePath);
      assert.deepEqual(validations[0]?.selection, modelSelection);
      assert.equal(validations[0]?.ceiling, "full-access");
      assert.equal(result.cwd, managedBinding.workspacePath);
      assert.equal(result.managedAgent, true);
      assert.equal(result.approvalPolicy, "never");
      assert.equal(result.interactionMode, "default");
      assert.deepEqual(result.sandboxPolicy, { type: "readOnly", networkAccess: false });
    }),
  );
  it.effect(
    "validates each advisor consultation at its current revision while retaining the initial binding",
    () =>
      Effect.gen(function* () {
        const policy = yield* RuntimePolicy.RuntimePolicyV2;
        const now = yield* DateTime.now;
        const initial = { ...managedBinding, role: "advisor" as const };
        let validated: AgentTaskBinding | undefined;
        const result = yield* policy
          .resolve({
            thread: {
              ...makeThread({
                now,
                worktreePath: initial.workspacePath,
                runtimeMode: "full-access",
              }),
              agentTask: initial,
              followupSourceRevision: "next-source",
            },
            modelSelection,
          })
          .pipe(
            Effect.provide(
              Layer.mergeAll(
                ServerSettings.layerTest(),
                Layer.mock(ManagedAgent.ManagedAgentService)({
                  validate: (input) =>
                    Effect.sync(() => {
                      validated = input.binding;
                    }),
                }),
              ),
            ),
          );
        assert.equal(validated?.sourceRevision, "next-source");
        assert.equal(initial.sourceRevision, "pinned-source");
        assert.deepEqual(validated?.effective, initial.effective);
        assert.deepEqual(result.sandboxPolicy, { type: "readOnly", networkAccess: false });
      }),
  );

  it.effect(
    "continues a pinned worker at its follow-up revision and leaves an unpinned worker unpinned",
    () =>
      Effect.gen(function* () {
        const policy = yield* RuntimePolicy.RuntimePolicyV2;
        const now = yield* DateTime.now;
        const worker = {
          ...managedBinding,
          role: "implementation-worker" as const,
          sourceAccess: "scoped-write" as const,
          toolProfile: "implementation" as const,
        };
        const { sourceRevision: _pinned, ...unpinned } = worker;
        const validatedFor = (agentTask: AgentTaskBinding) => {
          let validated: AgentTaskBinding | undefined;
          return policy
            .resolve({
              thread: {
                ...makeThread({
                  now,
                  worktreePath: agentTask.workspacePath,
                  runtimeMode: "full-access",
                }),
                agentTask,
                followupSourceRevision: "corrected-source",
              },
              modelSelection,
            })
            .pipe(
              Effect.provide(
                Layer.mergeAll(
                  ServerSettings.layerTest(),
                  Layer.mock(ManagedAgent.ManagedAgentService)({
                    validate: (input) =>
                      Effect.sync(() => {
                        validated = input.binding;
                      }),
                  }),
                ),
              ),
              Effect.map(() => validated),
            );
        };
        assert.equal((yield* validatedFor(worker))?.sourceRevision, "corrected-source");
        assert.isUndefined((yield* validatedFor(unpinned))?.sourceRevision);
      }),
  );

  it.effect("requires settings authority and rejects a current project account revocation", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const call = policy.resolve({
        thread: {
          ...makeThread({ now, worktreePath: managedBinding.workspacePath }),
          agentTask: managedBinding,
        },
        modelSelection,
      });
      let validations = 0;
      const guard = Layer.mock(ManagedAgent.ManagedAgentService)({
        validate: () =>
          Effect.sync(() => {
            validations++;
          }),
      });
      const missing = yield* call.pipe(Effect.provide(guard), Effect.flip);
      assert.equal(missing._tag, "RuntimePolicyResolveError");
      assert.equal(validations, 0);
      yield* Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* call;
        assert.equal(validations, 1);
        yield* settings.updateSettings({
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [providerInstanceId]: { enabled: false } } },
          },
        });
        const revoked = yield* call.pipe(Effect.flip);
        assert.equal(revoked._tag, "RuntimePolicyResolveError");
        assert.equal(validations, 1);
      }).pipe(Effect.provide(Layer.mergeAll(guard, ServerSettings.layerTest())));
    }),
  );
});
