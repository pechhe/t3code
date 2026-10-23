import * as ForgeWorkItems from "../hq/ForgeWorkItems.ts";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type AgentTaskBinding,
  type ExperimentWorkUnit,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Experiments from "../experiments/ExperimentService.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as ExternalAgentWork from "../agents/ExternalAgentWorkService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ReleaseApprovals from "../releases/ReleaseApprovals.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import {
  request as taskRequest,
  codex,
  snapshot as agentPolicySnapshot,
} from "../agents/agentPolicy.testkit.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const environmentId = EnvironmentId.make("environment:work-mcp-test");
const projectId = ProjectId.make("project:mcp-test");
const parentThreadId = ThreadId.make("thread:work-parent");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.6-test",
};

const threadScope = (threadId = parentThreadId): McpInvocationScope => ({
  environmentId,
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

const externalScope: McpInvocationScope = {
  environmentId,
  requestNamespace: "client:external-work",
  thread: undefined,
  client: {
    sessionId: "oauth-session",
    label: "External MCP client",
    access: "full-access",
  },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const project = {
  id: projectId,
  workspaceRoot: "/fixture/project-root",
  defaultModelSelection: modelSelection,
} as never;

const parentProjection = (active = true) => {
  const shell = liveThreadShell(parentThreadId);
  return {
    ...idleThreadProjection(shell),
    runs: active
      ? [
          {
            id: RunId.make("run:work-parent"),
            ordinal: 1,
            status: "running",
            rootNodeId: "node:work-parent",
            providerInstanceId,
            modelSelection,
          },
        ]
      : [],
  } as unknown as OrchestrationV2ThreadProjection;
};

const dependencies = (input: {
  readonly managed?: Partial<ManagedAgent.ManagedAgentService["Service"]>;
  readonly experiments?: Partial<Experiments.ExperimentService["Service"]>;
  readonly threads?: Partial<ThreadManagement.ThreadManagementService["Service"]>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly adapters?: ReadonlyArray<ProviderInstanceId>;
  readonly recordWorkOutcome?: (value: unknown, reader: unknown) => Effect.Effect<never, never>;
  readonly projection?: OrchestrationV2ThreadProjection;
  readonly managedLeaf?: boolean;
  readonly enrollWork?: (value: unknown) => Effect.Effect<never, never>;
  readonly allocateWork?: (value: unknown, reader: unknown) => Effect.Effect<never, never>;
  readonly recordWorkEvidence?: (value: unknown, reader: unknown) => Effect.Effect<never, never>;
  readonly readWork?: (value: unknown, reader: unknown) => Effect.Effect<never, never>;
  readonly session?: (scope: McpInvocationScope, key: string) => Effect.Effect<never, never>;
}) => {
  const shell = {
    ...liveThreadShell(parentThreadId),
    ...(input.managedLeaf ? { agentTask: { externalOwner: { environmentId } } } : {}),
  } as never;
  const managedLayer = Layer.mock(ManagedAgent.ManagedAgentService)({
    snapshot: () => Effect.succeed(agentPolicySnapshot()),
    targetProject: ({ callerProjectId }) => Effect.succeed(callerProjectId),
    ...input.managed,
  });
  const externalLayer = Layer.mock(ExternalAgentWork.ExternalAgentWorkService)({
    session: (scope, key) =>
      input.session?.(scope, key) ?? Effect.die("unexpected external session lookup"),
  });
  const serviceLayer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mock(ForgeWorkItems.ForgeWorkItems)({
        connected: Effect.succeed({ connected: false, origin: null }),
      }),
    ),
    Layer.provide(WorkspaceProvider.layerGitWorktree),
    Layer.provide(
      Layer.mergeAll(
        Layer.merge(
          NodeServices.layer,
          Layer.mock(Experiments.ExperimentService)({
            enrollWork: (value) =>
              input.enrollWork?.(value) ?? Effect.die("unexpected enrollWork call"),
            allocateWork: (value, reader) =>
              input.allocateWork?.(value, reader) ?? Effect.die("unexpected allocateWork call"),
            recordWorkEvidence: (value, reader) =>
              input.recordWorkEvidence?.(value, reader) ??
              Effect.die("unexpected recordWorkEvidence call"),
            readWork: (value, reader) =>
              input.readWork?.(value, reader) ?? Effect.die("unexpected readWork call"),
            recordWorkOutcome: (value, reader) =>
              input.recordWorkOutcome?.(value, reader) ?? Effect.die("unexpected outcome"),
            ...input.experiments,
          }),
        ),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: () => {
            const projection = input.projection ?? parentProjection();
            return Effect.succeed(
              input.managedLeaf
                ? ({
                    ...projection,
                    thread: {
                      ...projection.thread,
                      agentTask: (shell as { readonly agentTask?: unknown }).agentTask,
                    },
                  } as OrchestrationV2ThreadProjection)
                : projection,
            );
          },
          getThreadShell: () => Effect.succeed(shell),
          ...input.threads,
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(input.providers ?? []),
        }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed(input.adapters ?? []),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ReleaseApprovals.ReleaseApprovals)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      ),
    ),
  );
  return Layer.mergeAll(serviceLayer, managedLayer, externalLayer);
};

const withService = <A, E, LE, R>(
  layer: Layer.Layer<OrchestratorMcpService.OrchestratorMcpService, LE, R>,
  run: (service: OrchestratorMcpService.OrchestratorMcpService["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    return yield* run(service);
  }).pipe(Effect.provide(layer));

it.effect("derives T3 enrollment ownership and model from the active parent run", () =>
  Effect.gen(function* () {
    const enrolled = yield* Ref.make<unknown[]>([]);
    const input = {
      workId: "work:internal",
      description: "Internal work",
      taskCategory: "test",
    };
    const layer = dependencies({
      enrollWork: (value) =>
        Ref.update(enrolled, (values) => [...values, value]).pipe(Effect.as({} as never)),
    });
    yield* withService(layer, (service) => service.enrollWork(threadScope(), input));
    const calls = yield* Ref.get(enrolled);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      request: input,
      owner: {
        environmentId,
        projectId,
        workspacePath: "/fixture/project-root",
        parentThreadId,
        externalSessionKey: null,
        clientSessionId: null,
      },
      orchestratorSelection: modelSelection,
      modelSource: "run-selection",
      policyHash: agentPolicySnapshot().hash,
      policyRevision: agentPolicySnapshot().sourceRevision,
      alreadyStarted: false,
    });

    const spoofAttempt = {
      ...input,
      externalSessionKey: "other-session",
      reportedOrchestratorSelection: {
        instanceId: providerInstanceId,
        model: "spoofed",
      },
    };
    const error = yield* withService(layer, (service) =>
      service.enrollWork(threadScope(), spoofAttempt).pipe(Effect.flip),
    );
    assert.instanceOf(error, OrchestratorMcpFailure);
    assert.equal(error.code, "invalid_request");
    assert.equal((yield* Ref.get(enrolled)).length, 1);
  }),
);

it.effect("derives external enrollment ownership from the attached session", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<unknown[]>([]);
    const sessionKey = "a".repeat(64);
    const input = {
      workId: "work:external",
      description: "External work",
      taskCategory: "test",
      externalSessionKey: sessionKey,
      reportedOrchestratorSelection: modelSelection,
    };
    const serviceLayer = dependencies({
      session: (scope, key) => {
        assert.equal(scope, externalScope);
        assert.equal(key, sessionKey);
        return Effect.succeed({
          key: sessionKey,
          clientSessionId: "oauth-session",
          projectId,
          workspacePath: "/fixture/attached-workspace",
        } as never);
      },
      enrollWork: (value) =>
        Ref.update(calls, (values) => [...values, value]).pipe(Effect.as({} as never)),
    });
    yield* withService(serviceLayer, (service) => service.enrollWork(externalScope, input));
    const [call] = yield* Ref.get(calls);
    assert.deepEqual(call, {
      request: input,
      owner: {
        environmentId,
        projectId,
        workspacePath: "/fixture/attached-workspace",
        parentThreadId: null,
        externalSessionKey: sessionKey,
        clientSessionId: "oauth-session",
      },
      orchestratorSelection: modelSelection,
      modelSource: "self-report",
      policyHash: agentPolicySnapshot().hash,
      policyRevision: agentPolicySnapshot().sourceRevision,
      alreadyStarted: false,
    });
  }),
);

it.effect("refuses stale parents and managed leaves before recording work", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const capture = () => Ref.update(calls, (count) => count + 1).pipe(Effect.as({} as never));
    const staleLayer = dependencies({
      projection: parentProjection(false),
      allocateWork: capture,
    });
    const stale = yield* withService(staleLayer, (service) =>
      service
        .allocateWork(threadScope(), {
          id: "allocation:stale",
          workUnitId: "work:unit",
          allocation: "inline",
          reason: "test",
          deviationReason: null,
        })
        .pipe(Effect.flip),
    );
    assert.equal(stale.code, "parent_not_active");

    const leafLayer = dependencies({
      managedLeaf: true,
      recordWorkEvidence: capture,
    });
    const leaf = yield* withService(leafLayer, (service) =>
      service
        .recordWorkEvidence(threadScope(), {
          id: "evidence:leaf",
          workUnitId: "work:unit",
          actor: "parent",
          phase: "execution",
          attribution: "whole-turn",
          threadId: null,
          providerTurnId: null,
          externalSegmentId: null,
          startedAt: null,
          completedAt: null,
          usage: null,
          evidence: [],
        })
        .pipe(Effect.flip),
    );
    assert.equal(leaf.code, "capability_denied");
    assert.equal(yield* Ref.get(calls), 0);
  }),
);

it.effect("allows an external read-only caller to request its owned work report", () =>
  Effect.gen(function* () {
    const readers = yield* Ref.make<unknown[]>([]);
    const reader = {
      environmentId,
      clientSessionId: "oauth-session",
      threadId: undefined,
    };
    const serviceLayer = dependencies({
      readWork: (_input, value) =>
        Ref.update(readers, (values) => [...values, value]).pipe(Effect.as({} as never)),
    });
    const scope = {
      ...externalScope,
      client: { ...externalScope.client!, access: "read-only" as const },
    };
    yield* withService(serviceLayer, (service) =>
      service.readWork(scope, { workUnitId: "work:owned" }),
    );
    assert.deepEqual(yield* Ref.get(readers), [reader]);
  }),
);

it.effect(
  "refuses all work mutations for a read-only external caller before touching experiment state",
  () =>
    Effect.gen(function* () {
      const readonly = {
        ...externalScope,
        client: { ...externalScope.client!, access: "read-only" as const },
      };
      yield* withService(dependencies({}), (service) =>
        Effect.gen(function* () {
          const enrollment = yield* service
            .enrollWork(readonly, { workId: "unit", description: "Work", taskCategory: "test" })
            .pipe(Effect.flip);
          const allocation = yield* service
            .allocateWork(readonly, {
              id: "allocate",
              workUnitId: "unit",
              allocation: "inline",
              reason: "Lead context",
              deviationReason: null,
            })
            .pipe(Effect.flip);
          const evidence = yield* service
            .recordWorkEvidence(readonly, {
              id: "evidence",
              workUnitId: "unit",
              actor: "parent",
              phase: "inspection",
              attribution: "unavailable",
              threadId: null,
              providerTurnId: null,
              externalSegmentId: null,
              startedAt: null,
              completedAt: null,
              usage: null,
              evidence: [],
            })
            .pipe(Effect.flip);
          assert.deepEqual(
            [enrollment.code, allocation.code, evidence.code],
            ["capability_denied", "capability_denied", "capability_denied"],
          );
        }),
      );
    }),
);

it.effect(
  "a supervised external parent can submit its owned inline outcome without environment-management permission",
  () =>
    Effect.gen(function* () {
      const claims = yield* Ref.make<unknown[]>([]);
      const scope = {
        ...externalScope,
        client: { ...externalScope.client!, access: "auto-accept-edits" as const },
      };
      const outcome = {
        id: "claim",
        assignmentId: "assignment:owned",
        runId: null,
        kind: "verified-completion" as const,
        source: "self-report" as const,
        evidence: ["check"],
        note: "Completed inline",
        actualModelSelection: null,
        fallbackReason: null,
      };
      yield* withService(
        dependencies({
          recordWorkOutcome: (input, reader) =>
            Ref.update(claims, (items) => [...items, { input, reader }]).pipe(
              Effect.as({} as never),
            ),
        }),
        (service) => service.recordWorkOutcome(scope, outcome),
      );
      assert.deepEqual(yield* Ref.get(claims), [
        {
          input: outcome,
          reader: { environmentId, clientSessionId: "oauth-session", threadId: undefined },
        },
      ]);
      yield* withService(dependencies({}), (service) =>
        service
          .recordWorkOutcome(
            { ...scope, client: { ...scope.client, access: "read-only" } },
            outcome,
          )
          .pipe(
            Effect.flip,
            Effect.map((error) => assert.equal(error.code, "capability_denied")),
          ),
      );
    }),
);

it.effect(
  "validates child modes before reserving and records definite versus unknown dispatch acceptance",
  () =>
    Effect.gen(function* () {
      for (const scenario of [
        "mode-refused",
        "dispatch-refused",
        "dispatch-accepted",
        "dispatch-unknown",
      ] as const) {
        const reservations = yield* Ref.make(0);
        const dispatches = yield* Ref.make(0);
        const receipts = yield* Ref.make(0);
        const states = yield* Ref.make<string[]>([]);
        const parent = {
          ...parentProjection(),
          thread: {
            ...parentProjection().thread,
            runtimeMode: "auto-accept-edits" as const,
            worktreePath: "/fixture/project-root",
          },
        };
        const request = {
          ...taskRequest({ workspacePath: "/fixture/project-root" }),
          workUnitId: "unit:launch",
        };
        const binding: AgentTaskBinding = {
          ...request,
          policyHash: agentPolicySnapshot().hash,
          policyRevision: agentPolicySnapshot().sourceRevision,
          briefHash: agentPolicySnapshot().briefs[request.role]!.hash,
          requestFingerprint: "a".repeat(64),
          sourceAccess: "scoped-write",
          toolProfile: "implementation",
          requested: modelSelection,
          assigned: null,
          effective: modelSelection,
        };
        const unit = {
          id: "unit:launch",
          policyHash: binding.policyHash,
          assignmentIds: [],
        } as unknown as ExperimentWorkUnit;
        const error = new OrchestratorProjectionError({ threadId: parentThreadId });
        const layer = dependencies({
          projection: parent,
          providers: [
            {
              ...codex,
              instanceId: providerInstanceId,
              models: [{ ...codex.models[0]!, slug: modelSelection.model }],
            },
          ],
          adapters: [providerInstanceId],
          managed: {
            prepare: () => Effect.succeed({ binding, brief: "Role brief" }),
            validate: () => Effect.void,
          },
          experiments: {
            assignments: () => Effect.succeed([]),
            assignForTask: () => Effect.succeed([]),
            workDispatchPolicy: () => Effect.succeed(unit),
            readWork: () => Effect.succeed({ tasks: [] } as never),
            registerWorkTask: () => Ref.update(reservations, (n) => n + 1),
            recordWorkTaskLaunch: (input) =>
              Ref.update(states, (values) => [...values, input.state]),
          },
          threads: {
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            hasReceipt: () =>
              Ref.getAndUpdate(receipts, (n) => n + 1).pipe(
                Effect.flatMap((n) =>
                  n === 0
                    ? Effect.succeed(false)
                    : scenario === "dispatch-unknown"
                      ? Effect.die(error)
                      : Effect.succeed(scenario === "dispatch-accepted"),
                ),
              ),
            dispatch: () =>
              Ref.update(dispatches, (n) => n + 1).pipe(Effect.andThen(Effect.fail(error))),
          },
        });
        const failed = yield* withService(layer, (service) =>
          service
            .delegateTask(threadScope(), {
              task: "Implement bounded work",
              clientRequestId: scenario,
              agentTask: request,
              ...(scenario === "mode-refused" ? { runtimeMode: "full-access" as const } : {}),
            })
            .pipe(Effect.flip),
        );
        assert.equal(
          failed.code,
          scenario === "mode-refused" ? "runtime_mode_escalation_denied" : "orchestration_error",
        );
        assert.equal(yield* Ref.get(reservations), scenario === "mode-refused" ? 0 : 1);
        assert.equal(yield* Ref.get(dispatches), scenario === "mode-refused" ? 0 : 1);
        assert.deepEqual(
          yield* Ref.get(states),
          scenario === "mode-refused"
            ? []
            : [
                scenario === "dispatch-refused"
                  ? "refused"
                  : scenario === "dispatch-accepted"
                    ? "accepted"
                    : "launch-unknown",
              ],
        );
      }
    }),
);
