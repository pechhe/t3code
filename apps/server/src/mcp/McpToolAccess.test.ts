import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type AgentRole,
  type AgentTaskBinding,
  type AgentTaskRequest,
  type AgentToolProfile,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import {
  request as agentTaskRequest,
  snapshot as agentPolicySnapshot,
} from "../agents/agentPolicy.testkit.ts";

const supervisedThreadId = ThreadId.make("thread:supervised");
const planThreadId = ThreadId.make("thread:plan");
const fullAccessThreadId = ThreadId.make("thread:full-access");
const endedThreadId = ThreadId.make("thread:ended");
const externalManagedThreadId = ThreadId.make("thread:external-managed");
const browserChildThreadId = ThreadId.make("thread:browser-child");
const verifierChildThreadId = ThreadId.make("thread:ui-verifier-child");
const reviewerChildThreadId = ThreadId.make("thread:spec-reviewer-child");
const scoutChildThreadId = ThreadId.make("thread:scout-child");
const endedBrowserChildThreadId = ThreadId.make("thread:ended-browser-child");

const taskBinding = (
  task: AgentTaskRequest,
  toolProfile: AgentToolProfile,
  sourceAccess: AgentTaskBinding["sourceAccess"],
): AgentTaskBinding => {
  const policy = agentPolicySnapshot();
  const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-sol-test" };
  return {
    ...task,
    requestFingerprint: "c".repeat(64),
    policyHash: policy.hash,
    policyRevision: policy.sourceRevision,
    // A policy may leave `researcher` and `scout` out; their tasks are then unavailable.
    briefHash: policy.briefs[task.role]?.hash ?? "b".repeat(64),
    sourceAccess,
    toolProfile,
    requested: selection,
    assigned: null,
    effective: selection,
  };
};

const externalTaskBinding = (): AgentTaskBinding => ({
  ...taskBinding(agentTaskRequest(), "implementation", "scoped-write"),
  externalOwner: {
    environmentId: EnvironmentId.make("environment"),
    clientSessionId: "session",
    externalSessionKey: "a".repeat(64),
    projectId: ProjectId.make("project:mcp-test"),
    ceiling: "full-access",
  },
});

/** A delegated child's shell, as its own thread's projection carries it. */
const childShell = (threadId: ThreadId, role: AgentRole, toolProfile: AgentToolProfile) => ({
  ...liveThreadShell(threadId),
  agentTask: taskBinding(agentTaskRequest({ role, taskClass: "ui" }), toolProfile, "read-only"),
});

const backgroundThreadId = ThreadId.make("thread:background");
const oldProviderThreadId = ThreadId.make("thread:old-provider-background");
const archivedThreadId = ThreadId.make("thread:archived-background");
const unknownOwnerThreadId = ThreadId.make("thread:unknown-background-owner");

const backgroundShell = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) => ({
  ...liveThreadShell(threadId, { activeRunId: null }),
  pendingBackgroundTasks: [
    { taskId: "task:background", kind: "subagent" as const, providerInstanceId },
  ],
});

const shells = new Map([
  [supervisedThreadId, liveThreadShell(supervisedThreadId, { runtimeMode: "approval-required" })],
  [
    planThreadId,
    liveThreadShell(planThreadId, { runtimeMode: "approval-required", interactionMode: "plan" }),
  ],
  [fullAccessThreadId, liveThreadShell(fullAccessThreadId)],
  [endedThreadId, liveThreadShell(endedThreadId, { activeRunId: null })],
  [
    externalManagedThreadId,
    { ...liveThreadShell(externalManagedThreadId), agentTask: externalTaskBinding() },
  ],
  [browserChildThreadId, childShell(browserChildThreadId, "browser", "phi")],
  [verifierChildThreadId, childShell(verifierChildThreadId, "ui-verifier", "phi")],
  [reviewerChildThreadId, childShell(reviewerChildThreadId, "spec-reviewer", "source-reader")],
  [scoutChildThreadId, childShell(scoutChildThreadId, "scout", "source-reader")],
  [
    endedBrowserChildThreadId,
    {
      ...liveThreadShell(endedBrowserChildThreadId, { activeRunId: null }),
      agentTask: childShell(endedBrowserChildThreadId, "browser", "phi").agentTask,
    },
  ],
  [backgroundThreadId, backgroundShell(backgroundThreadId, ProviderInstanceId.make("codex"))],
  [oldProviderThreadId, backgroundShell(oldProviderThreadId, ProviderInstanceId.make("claude"))],
  [
    archivedThreadId,
    {
      ...backgroundShell(archivedThreadId, ProviderInstanceId.make("codex")),
      archivedAt: liveThreadShell(archivedThreadId).updatedAt,
    },
  ],
  [
    unknownOwnerThreadId,
    {
      ...liveThreadShell(unknownOwnerThreadId, { activeRunId: null }),
      pendingBackgroundTasks: [{ taskId: "task:unknown", kind: "subagent" as const }],
    },
  ],
]);

const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

/** The credential a delegated child's own endpoint issues for its role. */
const childCaller = (
  threadId: ThreadId,
  role: AgentRole,
  toolProfile: AgentToolProfile,
): McpInvocationContext.McpInvocationScope => ({
  ...threadCaller(threadId),
  capabilities: new Set(["orchestration", "preview"] as const),
  toolProfile,
  agentRole: role,
});

const clientCaller = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const probe = {
  success: Schema.Struct({ ran: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const ProbeToolkit = Toolkit.make(
  Tool.make("reads", probe),
  Tool.make("reads_task", probe),
  Tool.make("reads_as_caller", probe),
  Tool.make("reads_preview_backend", probe),
  Tool.make("acts_as_caller", probe),
  Tool.make("acts_as_preview_caller", probe),
  Tool.make("cleans_up_as_preview_caller", probe),
  Tool.make("writes", probe),
  Tool.make("writes_with_capability", probe),
  Tool.make("writes_threads", {
    ...probe,
    parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  }),
  Tool.make("starts_threads", {
    ...probe,
    parameters: Schema.Struct({
      runtimeMode: Schema.optional(RuntimeMode),
      interactionMode: Schema.optional(ProviderInteractionMode),
    }),
  }),
  Tool.make("writes_environment", probe),
);
const ran = Effect.succeed({ ran: "ran" });
const probeHandlers: McpToolAccess.Handlers<typeof ProbeToolkit.tools> = {
  reads: McpToolAccess.reads(() => ran),
  reads_task: McpToolAccess.readsTask(() => ran),
  reads_as_caller: McpToolAccess.readsAsCaller(() => ran),
  reads_preview_backend: McpToolAccess.readsAsPreviewCaller(() =>
    McpInvocationContext.McpInvocationContext.pipe(
      Effect.map((scope) => ({ ran: scope.browserBackends?.default ?? "none" })),
    ),
  ),
  acts_as_caller: McpToolAccess.actsAsCaller(() => ran),
  acts_as_preview_caller: McpToolAccess.actsAsPreviewCaller(() => ran),
  cleans_up_as_preview_caller: McpToolAccess.cleansUpAsPreviewCaller(() => ran),
  writes: McpToolAccess.writes(() => ran),
  writes_with_capability: McpToolAccess.writesWithCapability(() => ran),
  writes_threads: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    () => ran,
  ),
  starts_threads: McpToolAccess.startsThreads(
    (input) => input,
    (_, modes) => Effect.succeed({ ran: `${modes.runtimeMode}/${modes.interactionMode}` }),
  ),
  writes_environment: McpToolAccess.writesEnvironment(() => ran),
};
const layerProbeHandlers = McpToolAccess.toLayer(ProbeToolkit, probeHandlers);

const unchecked = () => ran;

// `@ts-expect-error` fails the build if one ever compiles. Never called.
export const refusedAtCompileTime = () => {
  McpToolAccess.toLayer(ProbeToolkit, {
    ...probeHandlers,
    // @ts-expect-error a handler that skips its declaration
    reads: unchecked,
  });
  McpToolAccess.toLayer(ProbeToolkit, {
    ...probeHandlers,
    // @ts-expect-error a declaration's fields copied onto an unchecked handler
    reads: Object.assign(
      unchecked,
      McpToolAccess.reads(() => ran),
    ),
  });
  // @ts-expect-error a declaration built outside McpToolAccess
  McpToolAccess.Declaration.make(unchecked);
  // @ts-expect-error a declaration constructed directly
  new McpToolAccess.Declaration(unchecked);
  // @ts-expect-error a handlers layer built outside McpToolAccess
  McpToolAccess.HandlersLayer.make(Layer.empty);
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  McpHttpServer.toolkitRegistration(
    ProbeToolkit,
    // @ts-expect-error a handlers layer that skipped `McpToolAccess.toLayer`
    ProbeToolkit.toLayer({
      reads: unchecked,
      reads_as_caller: unchecked,
      reads_preview_backend: unchecked,
      acts_as_caller: unchecked,
      acts_as_preview_caller: unchecked,
      cleans_up_as_preview_caller: unchecked,
      writes: unchecked,
      writes_with_capability: unchecked,
      writes_threads: unchecked,
      starts_threads: unchecked,
      writes_environment: unchecked,
    }),
  );
};

/** The browser access a managed child's own project grants it. */
const browserAccess = (
  overrides: Parameters<typeof ServerSettings.layerTest>[0] = {},
): Layer.Layer<ServerSettings.ServerSettingsService> =>
  ServerSettings.layerTest({
    enableAgentBrowserAccess: true,
    agentBrowserBackends: { enabled: ["phi"], default: "phi" },
    ...overrides,
  }).pipe(Layer.orDie);

const probeServer = (
  threads: Layer.Layer<ThreadManagement.ThreadManagementService>,
  settings: Layer.Layer<ServerSettings.ServerSettingsService> = browserAccess(),
) =>
  McpHttpServer.toolkitRegistration(ProbeToolkit, layerProbeHandlers).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(threads),
    Layer.provideMerge(settings),
  );

const decodeOutcome = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([Schema.Struct({ ran: Schema.String }), Schema.Struct({ code: Schema.String })]),
  ),
);

const call = (
  tool: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown> = {},
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: tool, arguments: args })),
    Effect.flatMap(({ content }) =>
      decodeOutcome(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.map((outcome) => ("code" in outcome ? outcome.code : outcome.ran)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const supervised = threadCaller(supervisedThreadId);
const plan = threadCaller(planThreadId);
const fullAccess = threadCaller(fullAccessThreadId);
const ended = threadCaller(endedThreadId);
const background = threadCaller(backgroundThreadId);
const oldProviderBackground = threadCaller(oldProviderThreadId);
const archivedBackground = threadCaller(archivedThreadId);
const unknownOwnerBackground = threadCaller(unknownOwnerThreadId);
const mismatchedProvider = {
  ...background,
  thread: { ...background.thread!, providerInstanceId: ProviderInstanceId.make("claude") },
};
const supervisedClient = clientCaller("approval-required");
const fullAccessClient = clientCaller("full-access");
const readOnlyClient = clientCaller("read-only");
const foreignExternalClient: McpInvocationContext.McpInvocationScope = {
  ...fullAccessClient,
  client: { sessionId: "session:foreign", label: "Other client", access: "full-access" },
};
// A live full-access thread whose credential may use its browser but not control threads.
const previewOnly = { ...fullAccess, capabilities: new Set(["preview"] as const) };
const layerShells = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
});
const browserChild = childCaller(browserChildThreadId, "browser", "phi");
const verifierChild = childCaller(verifierChildThreadId, "ui-verifier", "phi");
const reviewerChild = childCaller(reviewerChildThreadId, "spec-reviewer", "source-reader");
const scoutChild = childCaller(scoutChildThreadId, "scout", "source-reader");
const endedBrowserChild = childCaller(endedBrowserChildThreadId, "browser", "phi");

it.effect.each([
  ["reads", ended, {}, "ran"],
  ["reads", supervisedClient, {}, "ran"],
  ["reads", readOnlyClient, {}, "ran"],
  // An external OAuth caller has no T3 parent run; task status is scoped by
  // the external work service to that client's owned tasks.
  ["reads_task", fullAccessClient, {}, "ran"],
  ["reads_task", readOnlyClient, {}, "ran"],

  ["writes", readOnlyClient, {}, "capability_denied"],
  ["writes_threads", readOnlyClient, { threadId: supervisedThreadId }, "capability_denied"],
  ["starts_threads", readOnlyClient, {}, "capability_denied"],
  ["writes_environment", readOnlyClient, {}, "capability_denied"],

  ["reads_as_caller", ended, {}, "ran"],
  ["reads_as_caller", fullAccessClient, {}, "thread_credential_required"],
  // A preview read keeps every caller's own scope: only a browser-driving credential is pinned to
  // Phi, and reads keep their existing lack of a liveness, settings or leaf check.
  ["reads_preview_backend", supervised, {}, "none"],
  ["reads_preview_backend", ended, {}, "none"],
  ["reads_preview_backend", browserChild, {}, "phi"],
  ["reads_preview_backend", verifierChild, {}, "phi"],
  ["reads_preview_backend", reviewerChild, {}, "none"],
  ["reads_preview_backend", readOnlyClient, {}, "thread_credential_required"],
  ["acts_as_caller", supervised, {}, "ran"],
  ["acts_as_caller", ended, {}, "parent_not_active"],
  ["acts_as_caller", background, {}, "ran"],
  ["acts_as_caller", oldProviderBackground, {}, "parent_not_active"],
  ["acts_as_caller", mismatchedProvider, {}, "parent_not_active"],
  ["acts_as_caller", archivedBackground, {}, "parent_not_active"],
  ["acts_as_caller", unknownOwnerBackground, {}, "parent_not_active"],
  ["acts_as_caller", fullAccessClient, {}, "thread_credential_required"],

  // A browser child acts on its own browser and nothing else. The policy table that decides its
  // listing decides this too, so a child whose endpoint lists no browser stays a leaf.
  ["acts_as_preview_caller", supervised, {}, "ran"],
  ["acts_as_preview_caller", browserChild, {}, "ran"],
  ["acts_as_preview_caller", verifierChild, {}, "ran"],
  ["acts_as_preview_caller", reviewerChild, {}, "capability_denied"],
  ["acts_as_preview_caller", scoutChild, {}, "capability_denied"],
  ["acts_as_preview_caller", endedBrowserChild, {}, "parent_not_active"],
  ["acts_as_preview_caller", readOnlyClient, {}, "thread_credential_required"],
  // Closing the tab its own session owns is the one action that survives revoked browser access.
  ["cleans_up_as_preview_caller", supervised, {}, "ran"],
  ["cleans_up_as_preview_caller", browserChild, {}, "ran"],
  ["cleans_up_as_preview_caller", verifierChild, {}, "ran"],
  ["cleans_up_as_preview_caller", reviewerChild, {}, "capability_denied"],
  ["cleans_up_as_preview_caller", endedBrowserChild, {}, "parent_not_active"],
  ["cleans_up_as_preview_caller", readOnlyClient, {}, "thread_credential_required"],
  // Driving its own browser does not open any part of the control plane to it.
  ["acts_as_caller", browserChild, {}, "capability_denied"],
  ["writes", browserChild, {}, "capability_denied"],
  ["writes_threads", browserChild, { threadId: supervisedThreadId }, "capability_denied"],
  ["starts_threads", browserChild, {}, "capability_denied"],
  ["writes_environment", browserChild, {}, "capability_denied"],

  ["writes", supervised, {}, "ran"],
  ["writes", ended, {}, "parent_not_active"],
  ["writes", background, {}, "ran"],
  ["writes", oldProviderBackground, {}, "parent_not_active"],
  ["writes", supervisedClient, {}, "ran"],
  ["writes", previewOnly, {}, "capability_denied"],
  ["writes_environment", previewOnly, {}, "capability_denied"],

  ["writes_with_capability", previewOnly, {}, "ran"],
  ["writes_with_capability", readOnlyClient, {}, "capability_denied"],
  ["writes_with_capability", ended, {}, "parent_not_active"],

  ["writes_threads", supervised, {}, "ran"],
  ["writes_threads", supervised, { threadId: planThreadId }, "ran"],
  [
    "writes_threads",
    supervised,
    { threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],
  ["writes_threads", plan, { threadId: supervisedThreadId }, "interaction_mode_escalation_denied"],
  ["writes_threads", fullAccess, { threadId: supervisedThreadId }, "ran"],
  ["writes_threads", ended, { threadId: supervisedThreadId }, "parent_not_active"],
  ["writes_threads", supervisedClient, { threadId: supervisedThreadId }, "ran"],
  // Owned lifecycle tools remain available, but generic thread writes are closed for managed work.
  ["writes_threads", fullAccessClient, { threadId: externalManagedThreadId }, "capability_denied"],
  [
    "writes_threads",
    foreignExternalClient,
    { threadId: externalManagedThreadId },
    "task_not_found",
  ],
  [
    "writes_threads",
    supervisedClient,
    { threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],
  ["writes_threads", supervised, { threadId: "thread:missing" }, "ran"],

  ["starts_threads", supervised, {}, "approval-required/default"],
  ["starts_threads", supervised, { runtimeMode: "full-access" }, "runtime_mode_escalation_denied"],
  ["starts_threads", plan, {}, "approval-required/plan"],
  ["starts_threads", plan, { interactionMode: "default" }, "interaction_mode_escalation_denied"],
  ["starts_threads", fullAccess, { runtimeMode: "auto", interactionMode: "plan" }, "auto/plan"],
  ["starts_threads", ended, {}, "parent_not_active"],
  ["starts_threads", supervisedClient, {}, "approval-required/default"],
  ["starts_threads", supervisedClient, { runtimeMode: "auto" }, "runtime_mode_escalation_denied"],
  ["starts_threads", fullAccessClient, { runtimeMode: "full-access" }, "full-access/default"],

  ["writes_environment", fullAccess, {}, "ran"],
  ["writes_environment", supervised, {}, "capability_denied"],
  ["writes_environment", plan, {}, "capability_denied"],
  ["writes_environment", fullAccessClient, {}, "ran"],
  ["writes_environment", supervisedClient, {}, "capability_denied"],
] as const)("%s from %o with %o: %s", ([tool, scope, args, expected]) =>
  call(tool, scope, args).pipe(
    Effect.map((outcome) => expect(outcome).toBe(expected)),
    Effect.provide(probeServer(layerShells)),
  ),
);

it.effect.each([
  ["acts_as_preview_caller", "capability_denied"],
  ["cleans_up_as_preview_caller", "ran"],
  // Reads change nothing and still help find and close the owned tab, so they stay allowed.
  ["reads_preview_backend", "phi"],
] as const)("with browser access revoked a browser child's %s is %s", ([tool, expected]) =>
  call(tool, browserChild).pipe(
    Effect.map((outcome) => expect(outcome).toBe(expected)),
    Effect.provide(probeServer(layerShells, browserAccess({ enableAgentBrowserAccess: false }))),
  ),
);

it("refuses a declaration or handlers layer that only wears another's fields", () => {
  const copiedDeclaration = Object.assign(
    unchecked,
    McpToolAccess.reads(() => ran),
  );
  expect(() =>
    McpToolAccess.toLayer(ProbeToolkit, {
      ...probeHandlers,
      // @ts-expect-error a declaration's fields copied onto an unchecked handler
      reads: copiedDeclaration,
    }),
  ).toThrow(TypeError);
  const copiedLayer = Object.assign(Layer.empty, layerProbeHandlers);
  expect(() => McpToolAccess.HandlersLayer.layer(copiedLayer)).toThrow(TypeError);
});

it.effect("refuses a change when the calling thread cannot be read", () =>
  call("writes", supervised).pipe(
    Effect.map((outcome) => expect(outcome).toBe("orchestration_error")),
    Effect.provide(
      probeServer(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.fail(new OrchestratorProjectionError({ threadId, cause: "unreadable" })),
        }),
      ),
    ),
  ),
);
