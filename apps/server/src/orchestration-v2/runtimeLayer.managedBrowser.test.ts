import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { layerSyntheticWorkspaces } from "./testkit/runWorkspaceCustody.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";

const layerProjectHydrationTest = Layer.mergeAll(
  Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
    peek: () =>
      Effect.succeed({
        repositoryIdentity: null,
        faviconPath: null,
        repositoryIdentityResolved: false,
      }),
    getAvailable: () =>
      Effect.succeed({
        repositoryIdentity: null,
        faviconPath: null,
        repositoryIdentityResolved: false,
      }),
    invalidate: () => Effect.void,
    readRepositoryIdentity: () => Effect.succeed(null),
  }),
  Layer.mock(WorkspacePaths.WorkspacePaths)({
    normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
  }),
);

const layerPlatformTest = Layer.mergeAll(
  NodeServices.layer,
  layerSyntheticWorkspaces,
  NodeCrypto.layer,
  layerProjectHydrationTest,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-managed-browser-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);
const layerGitWorkflowTest = Layer.mock(GitWorkflow.GitWorkflowService)({
  pruneWorktrees: () => Effect.void,
  createWorktree: () => Effect.succeed({} as never),
});

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by this fixture"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const seedProject = (input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly createdAt: string;
}) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${input.projectId}`),
      aggregateKind: "project",
      aggregateId: input.projectId,
      occurredAt: input.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: input.projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        defaultModelSelection: input.defaultModelSelection,
        scripts: [],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    }),
  );

it.effect.each([
  "unrelated-override",
  "current-allow",
  "current-deny",
  "backend-disabled",
] as const)("the shared runtime composition preserves managed browser access for %s", (scenario) =>
  Effect.gen(function* () {
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    const captured = yield* Ref.make<ReadonlyArray<boolean>>([]);
    const projectId = ProjectId.make("project:runtime-browser-access");
    const otherProjectId = ProjectId.make("project:runtime-browser-other");
    const threadId = ThreadId.make("thread:runtime-browser-access");
    const instance: ProviderInstance = {
      ...providerInstance,
      orchestrationAdapter: {
        ...orchestrationAdapter,
        openSession: (input) =>
          Effect.gen(function* () {
            const config = yield* mcpSessions.read(input.threadId);
            yield* Ref.update(captured, (values) => [...values, config !== undefined]);
            return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver,
              providerSessionId: input.providerSessionId,
              cause: "The fixture stops before starting a provider process.",
            });
          }),
      },
    };
    const fixture = Layer.mergeAll(
      RuntimeLayer.layerProviderSessionManagerProvided,
      RuntimeLayer.layerEventSink,
      ProjectStore.layer,
    ).pipe(
      Layer.provide(McpSessionRegistryTestkit.layer),
      Layer.provide(Layer.succeed(McpProviderSessions.McpProviderSessions, mcpSessions)),
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(layerCheckpointStoreTest),
      Layer.provide(layerServerConfig),
      Layer.provide(
        ServerSettings.layerTest({
          enableAgentBrowserAccess: true,
          agentBrowserBackends:
            scenario === "backend-disabled"
              ? { enabled: ["phi"], default: "phi" }
              : { enabled: ["integrated", "phi"], default: "phi" },
          projectSettingsOverrides: {
            [otherProjectId]: { enableAgentBrowserAccess: true },
            ...(scenario === "current-allow" || scenario === "current-deny"
              ? { [projectId]: { enableAgentBrowserAccess: scenario === "current-allow" } }
              : {}),
          },
        }),
      ),
      Layer.provide(
        Layer.merge(
          ModelManifest.layerTest,
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: (id) => Effect.succeed(id === instance.instanceId ? instance : undefined),
          }),
        ),
      ),
      Layer.provide(layerGitWorkflowTest),
      Layer.provide(layerPlatformTest),
    );
    yield* Effect.gen(function* () {
      yield* seedProject({
        projectId,
        title: "Browser access",
        workspaceRoot: "/fixture/browser-access",
        defaultModelSelection: modelSelection,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const now = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("runtime-browser:create"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: {
              createdBy: "agent",
              creationSource: "mcp",
              id: threadId,
              projectId,
              title: "Managed integrated browser",
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
              agentTask: {
                role: "browser",
                taskClass: "ui",
                browser: { backend: "integrated" },
                workId: "browser-work",
                attemptId: "1",
                workspacePath: "/fixture/browser-access",
                sourceRevision: "revision-one",
                requestFingerprint: "a".repeat(64),
                policyHash: "b".repeat(64),
                policyRevision: "test",
                briefHash: "c".repeat(64),
                sourceAccess: "read-only",
                toolProfile: "phi",
                requested: modelSelection,
                assigned: null,
                effective: modelSelection,
              },
            },
          },
        ],
      });
      const result = yield* (yield* ProviderSessionManager.ProviderSessionManagerV2)
        .open({
          threadId,
          providerSessionId: ProviderSessionId.make("runtime-browser:session"),
          modelSelection,
          runtimePolicy: {
            managedAgent: true,
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: null,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
          },
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
    }).pipe(Effect.provide(fixture));
    assert.deepEqual(yield* Ref.get(captured), [
      scenario === "unrelated-override" || scenario === "current-allow",
    ]);
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);
