// Fork cases for CodexAdapterV2 live here; upstream's own cases stay in CodexAdapterV2.test.ts.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import packageJson from "../../../package.json" with { type: "json" };
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { MANAGED_BROWSER_TOOL_NAMES } from "../../mcp/toolkits/managedBrowser/toolNames.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});

const CODEX_TEST_MODEL_SELECTION = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeCodexTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Codex continuation test",
    providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
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

function makeCodexTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeCodexTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimePolicy: input.runtimePolicy ?? CODEX_TEST_RUNTIME_POLICY,
  };
}

function makeCodexReplayTurn(input: {
  readonly id: string;
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
}): Record<string, unknown> {
  const terminal =
    input.status === "completed" || input.status === "interrupted" || input.status === "failed";
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: terminal ? 1782622450 : null,
    durationMs: null,
  };
}

function codexReplayPreamble(input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
  readonly sentPrompt?: string;
  readonly effort?: string;
  readonly asksForEdits?: boolean;
  readonly turnPolicy?: Pick<
    typeof CodexClient.V2TurnStartParams.Type,
    "approvalPolicy" | "sandboxPolicy"
  >;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "T3 Code", title: "T3 Code", version: packageJson.version },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["turn/diff/updated"],
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "T3 Code/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: {
        id: 2,
        method: "thread/start",
        params: { config: CodexAdapterV2.CODEX_THREAD_CONFIG },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: 2,
        result: {
          thread: {
            id: input.nativeThreadId,
            sessionId: input.nativeThreadId,
            projectId: null,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${input.nativeThreadId}.jsonl`,
            cwd: "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: 3,
        method: "turn/start",
        params: {
          threadId: input.nativeThreadId,
          input: [{ type: "text", text: input.sentPrompt ?? input.prompt }],
          cwd: "/workspace",
          model: "gpt-5.4",
          approvalPolicy: input.asksForEdits === true ? "on-request" : "never",
          approvalsReviewer: "user",
          sandboxPolicy:
            input.asksForEdits === true ? { type: "workspaceWrite" } : { type: "dangerFullAccess" },
          ...input.turnPolicy,
          summary: "auto",
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          collaborationMode: {
            mode: "default",
            settings: {
              model: "gpt-5.4",
              ...(input.effort === undefined ? {} : { reasoning_effort: input.effort }),
            },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: {
        id: 3,
        result: { turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }) },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: input.nativeThreadId,
          turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }),
        },
      },
    },
  ];
}

/** Every turn/start follows a config/read; inserts that exchange and shifts later client ids. */
function withConfigReadBeforeTurnStart(
  entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
): Array<CodexReplay.CodexAppServerReplayEntry> {
  const result: Array<CodexReplay.CodexAppServerReplayEntry> = [];
  let offset = 0;
  let clientIds = new Map<number, number>();
  for (const entry of entries) {
    const frame = entry.type === "runtime_exit" ? undefined : entry.frame;
    if (!Predicate.isObject(frame) || typeof frame.id !== "number") {
      result.push(entry);
      continue;
    }
    if (entry.type === "expect_outbound" && typeof frame.method === "string") {
      if (frame.method === "initialize") {
        offset = 0;
        clientIds = new Map();
      }
      if (frame.method === "turn/start") {
        const id = frame.id + offset;
        const params = Predicate.isObject(frame.params) ? frame.params : {};
        result.push(
          {
            type: "expect_outbound",
            label: "config/read",
            frame: { id, method: "config/read", params: { cwd: params.cwd, includeLayers: false } },
          },
          {
            type: "emit_inbound",
            label: "config/read",
            frame: { id, result: { config: {}, origins: {} } },
          },
        );
        offset += 1;
      }
      clientIds.set(frame.id, frame.id + offset);
      result.push(withReplayRequestId(entry, frame.id + offset));
      continue;
    }
    const mapped = clientIds.get(frame.id);
    result.push(
      entry.type === "emit_inbound" && frame.method === undefined && mapped !== undefined
        ? withReplayRequestId(entry, mapped)
        : entry,
    );
  }
  return result;
}

function withConfigReads(
  transcript: CodexReplay.CodexAppServerReplayTranscript,
): CodexReplay.CodexAppServerReplayTranscript {
  return { ...transcript, entries: withConfigReadBeforeTurnStart(transcript.entries) };
}

function makeCodexReplayTranscript(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
}): CodexReplay.CodexAppServerReplayTranscript {
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.144.0",
    scenario: input.scenario,
    entries: input.entries,
  };
}

function withReplayRequestId(
  entry: CodexReplay.CodexAppServerReplayEntry,
  id: number,
): CodexReplay.CodexAppServerReplayEntry {
  return entry.type !== "runtime_exit" && Predicate.isObject(entry.frame)
    ? { ...entry, frame: { ...entry.frame, id } }
    : entry;
}

const makeChangeSignal = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<void>();
  const until = (predicate: () => boolean): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        while (!predicate()) yield* PubSub.take(subscription);
      }),
    );
  return { notify: PubSub.publish(changes, undefined), until };
});

const makeCodexReplayHarness = (
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  onEvent: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<unknown> = () =>
    Effect.void,
  onRequest: (method: string, params: unknown) => Effect.Effect<void> = () => Effect.void,
  readChildMetadata?: Parameters<typeof withCodexReplayChildMetadata>[2],
  beforeEmitInbound?: CodexReplay.CodexAppServerReplayDriver["beforeEmitInbound"],
  onUsageLimits?: CodexAdapterV2.CodexAdapterV2Options["onUsageLimits"],
  promptSuggestions: Effect.Effect<boolean> = Effect.succeed(false),
  onNotification: (method: string) => Effect.Effect<void> = () => Effect.void,
  models?: CodexAdapterV2.CodexAdapterV2Options["models"],
  readUsageIdentity?: CodexAdapterV2.CodexAdapterV2Options["readUsageIdentity"],
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const serverConfig = yield* ProviderReplayHarness.makeReplayServerConfig(
      transcript.scenario,
    ).pipe(Effect.orDie);
    const changes = yield* makeChangeSignal;
    const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
      [];
    const driver = yield* CodexReplay.makeReplayDriver(
      withConfigReads(transcript),
      beforeEmitInbound === undefined ? {} : { beforeEmitInbound },
    );
    const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
      open: (openInput) =>
        Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                providerSessionId: openInput.providerSessionId,
                cause,
              }),
          ),
          Effect.flatMap((context) =>
            Effect.service(CodexClient.CodexAppServerClient).pipe(
              Effect.map((client) =>
                withCodexReplayChildMetadata(client, transcript, readChildMetadata),
              ),
              Effect.map(
                (client) =>
                  ({
                    ...client,
                    request: (method, params) =>
                      onRequest(method, params).pipe(
                        Effect.andThen(client.request(method, params)),
                      ),
                    handleServerNotification: (method, handler) =>
                      client.handleServerNotification(method, (payload) =>
                        onNotification(method).pipe(Effect.andThen(handler(payload))),
                      ),
                    raw: {
                      ...client.raw,
                      request: (method, params) =>
                        onRequest(method, params).pipe(
                          Effect.andThen(client.raw.request(method, params)),
                        ),
                    },
                  }) satisfies CodexClient.CodexAppServerClient["Service"],
              ),
              Effect.provide(context),
            ),
          ),
        ),
    };
    const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: {},
      clientFactory,
      ...(onUsageLimits ? { onUsageLimits } : {}),
      ...(models ? { models } : {}),
      ...(readUsageIdentity ? { readUsageIdentity } : {}),
      digest: yield* Digest.Digest,
      fileSystem,
      idAllocator,
      serverConfig,
      continuationRequests: {
        offer: (request) =>
          Effect.sync(() => {
            continuationRequests.push(request);
          }).pipe(Effect.andThen(changes.notify)),
      },
    });
    const threadId = ThreadId.make(`thread-${transcript.scenario}`);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      promptSuggestions,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    const firstTerminal = yield* Deferred.make<void>();
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.terminal"
              ? Deferred.succeed(firstTerminal, undefined)
              : Effect.void,
          ),
          Effect.andThen(changes.notify),
          Effect.andThen(onEvent(event)),
        ),
      ),
      Effect.forkScoped,
    );
    if (runtime.hasPendingBackgroundWork === undefined) {
      return yield* Effect.die("Codex adapter runtime must expose hasPendingBackgroundWork.");
    }
    const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
    const terminalEvents = () =>
      events.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      );
    const subagentUpdates = () =>
      events.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }> =>
          event.type === "subagent.updated",
      );
    return {
      runtime,
      providerThread,
      threadId,
      serverConfig,
      events,
      continuationRequests,
      terminalEvents,
      subagentUpdates,
      hasPendingBackgroundWork,
      firstTerminal: Deferred.await(firstTerminal),
      until: changes.until,
      awaitTerminal: (count: number) => changes.until(() => terminalEvents().length >= count),
    };
  });

describe("CodexAdapterV2 process spawning", () => {
  it("locks managed native capabilities and disables every enumerated MCP server without T3 credentials", () => {
    const params = CodexAdapterV2.codexThreadRuntimeParams({
      mcpSession: undefined,
      modelSelection: { model: "gpt-5.4" },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/managed-workspace",
        managedAgent: true,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
      disabledMcpServers: ["external-shell", "browser-tools", "t3-code"],
    });
    assert.equal(params.cwd, "/managed-workspace");
    assert.equal(params.model, "gpt-5.4");
    assert.deepEqual(params.config, {
      "tools.update_plan.enabled": true,
      mcp_optional_startup_grace_ms: 10_000,
      "features.concurrent_reasoning_summaries": true,
      "features.multi_agent": false,
      "features.apps": false,
      "features.plugins": false,
      "features.browser_use": false,
      "features.computer_use": false,
      web_search: "disabled",
      mcp_servers: {
        "external-shell": { enabled: false },
        "browser-tools": { enabled: false },
        "t3-code": { enabled: false },
      },
    });
  });

  it("turns on live web search only for a managed web-research agent", () => {
    const params = CodexAdapterV2.codexThreadRuntimeParams({
      mcpSession: undefined,
      modelSelection: { model: "gpt-5.4" },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/managed-workspace",
        managedAgent: true,
        webResearch: true,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    });
    assert.equal(params.config["web_search"], "live");
    assert.equal(params.config["features.browser_use"], false);
  });

  it("keeps every other MCP server disabled while a managed browser task gets its own narrow endpoint", () => {
    const params = CodexAdapterV2.codexThreadRuntimeParams({
      mcpSession: {
        environmentId: EnvironmentId.make("managed-browser-environment"),
        threadId: ThreadId.make("managed-browser-thread"),
        providerSessionId: "managed-browser-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:43123/mcp/browser",
        authorizationHeader: "Bearer managed-browser-token",
        browserToolsAvailable: true,
        managedBrowser: true,
      },
      modelSelection: { model: "gpt-5.4" },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/managed-workspace",
        managedAgent: true,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
      disabledMcpServers: ["external-shell", "t3-code"],
    });
    const servers = params.config.mcp_servers as Record<string, Record<string, unknown>>;
    // The user's own servers stay off; only the pinned t3-code endpoint is on.
    assert.deepEqual(servers["external-shell"], { enabled: false });
    assert.equal(servers["t3-code"]?.url, "http://127.0.0.1:43123/mcp/browser");
    assert.equal(servers["t3-code"]?.default_tools_approval_mode, "approve");
    assert.deepEqual(servers["t3-code"]?.enabled_tools, [...MANAGED_BROWSER_TOOL_NAMES]);
    assert.notProperty(servers["t3-code"] ?? {}, "enabled");
  });

  it("attaches a managed reader's own T3 endpoint over any configured server of that name", () => {
    const readerSession = {
      environmentId: EnvironmentId.make("managed-reader-environment"),
      threadId: ThreadId.make("managed-reader-thread"),
      providerSessionId: "managed-reader-session",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:43123/mcp/reader",
      authorizationHeader: "Bearer managed-reader-token",
      browserToolsAvailable: false,
      delegated: true,
      listsPreview: false,
    };
    const runtimePolicy = {
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/managed-workspace",
      managedAgent: true,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    } as const;

    const servers = CodexAdapterV2.codexThreadRuntimeParams({
      mcpSession: readerSession,
      modelSelection: { model: "gpt-5.4" },
      runtimePolicy,
      disabledMcpServers: ["t3-code"],
    }).config.mcp_servers as Record<string, Record<string, unknown>>;
    assert.equal(servers["t3-code"]?.url, "http://127.0.0.1:43123/mcp/reader");
    assert.notProperty(servers["t3-code"] ?? {}, "enabled");
  });

  it("attaches the preview endpoint to a delegated browser child", () => {
    for (const session of [
      { endpoint: "http://127.0.0.1:43123/mcp/child-preview" },
      { endpoint: "http://127.0.0.1:43123/mcp/child-preview", listsDevice: true },
    ]) {
      const params = CodexAdapterV2.codexThreadRuntimeParams({
        mcpSession: {
          environmentId: EnvironmentId.make("managed-preview-child-environment"),
          threadId: ThreadId.make("managed-preview-child-thread"),
          providerSessionId: "managed-preview-child-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
          authorizationHeader: "Bearer managed-preview-child-token",
          browserToolsAvailable: true,
          delegated: true,
          listsPreview: true,
          ...session,
        },
        modelSelection: { model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/managed-workspace",
          managedAgent: true,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        },
        disabledMcpServers: ["external-shell", "t3-code"],
      });
      const servers = params.config.mcp_servers as Record<string, Record<string, unknown>>;
      // The user's own servers stay off; the child endpoint is on with T3's tools pre-approved.
      assert.deepEqual(servers["external-shell"], { enabled: false });
      assert.equal(servers["t3-code"]?.url, session.endpoint);
      assert.equal(servers["t3-code"]?.default_tools_approval_mode, "approve");
      // Its endpoint lists only the child's own families, so no narrower tool set is needed.
      assert.notProperty(servers["t3-code"] ?? {}, "enabled_tools");
      assert.notProperty(servers["t3-code"] ?? {}, "enabled");
    }
  });
});

describe("CodexAdapterV2 session initialize", () => {
  const openReplaySession = (
    transcript: CodexReplay.CodexAppServerReplayTranscript,
    beforeEmitInbound?: CodexReplay.CodexAppServerReplayDriver["beforeEmitInbound"],
    runtimePolicy = CODEX_TEST_RUNTIME_POLICY,
    sessionScope?: Scope.Scope,
    compatibility?: CodexAdapterV2.CodexAdapterV2Options["compatibility"],
  ) =>
    Effect.gen(function* () {
      const environments: Array<NodeJS.ProcessEnv | undefined> = [];
      const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
      const driver = yield* CodexReplay.makeReplayDriver(
        withConfigReads(transcript),
        beforeEmitInbound === undefined ? {} : { beforeEmitInbound },
      );
      let initializeRequests = 0;
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CODEX_SETTINGS,
        environment: {},
        ...(compatibility === undefined ? {} : { compatibility }),
        clientFactory: {
          open: (openInput) =>
            Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  environments.push(openInput.environment);
                }),
              ),
              Effect.flatMap((context) =>
                Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
              ),
              Effect.map(
                (client) =>
                  ({
                    ...client,
                    request: (method, params) =>
                      Effect.sync(() => {
                        requests.push({ method, params });
                        if (method === "initialize") initializeRequests++;
                      }).pipe(Effect.andThen(client.request(method, params))),
                  }) satisfies CodexClient.CodexAppServerClient["Service"],
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                    providerSessionId: openInput.providerSessionId,
                    cause,
                  }),
              ),
            ),
        },
        digest: yield* Digest.Digest,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ProviderReplayHarness.makeReplayServerConfig(transcript.scenario).pipe(
          Effect.orDie,
        ),
      });
      const threadId = ThreadId.make(`thread-${transcript.scenario}`);
      const open = adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy,
      });
      const runtime = yield* sessionScope === undefined
        ? open
        : open.pipe(Effect.provideService(Scope.Scope, sessionScope));
      return {
        environment: () => environments.at(-1),
        requests: () => requests,
        runtime,
        threadId,
        ensureThread: (threadId: string, policy = runtimePolicy) =>
          runtime.ensureThread({
            threadId: ThreadId.make(threadId),
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimePolicy: policy,
          }),
        initializeRequests: () => initializeRequests,
      };
    });

  const replayPreamble = (nativeThreadId: string) =>
    codexReplayPreamble({ nativeThreadId, nativeTurnId: "unused", prompt: "unused" });

  it.effect(
    "reads effective managed MCP servers and disables them before native thread start",
    () =>
      Effect.gen(function* () {
        const nativeThreadId = "managed-native-thread";
        const preamble = replayPreamble(nativeThreadId);
        const session = yield* openReplaySession(
          makeCodexReplayTranscript({
            scenario: "managed-mcp-enumeration",
            entries: [
              ...preamble.slice(0, 3),
              {
                type: "expect_outbound",
                label: "config/read",
                frame: {
                  id: 2,
                  method: "config/read",
                  params: { cwd: "/workspace", includeLayers: false },
                },
              },
              {
                type: "emit_inbound",
                label: "config/read",
                frame: {
                  id: 2,
                  result: {
                    config: {
                      mcp_servers: {
                        inherited: { command: "external" },
                        browser: { url: "http://example.invalid" },
                        "t3-code": { enabled: true },
                      },
                    },
                    origins: {},
                  },
                },
              },
              {
                type: "expect_outbound",
                label: "thread/start",
                frame: {
                  id: 3,
                  method: "thread/start",
                  params: {
                    cwd: "/workspace",
                    model: CODEX_TEST_MODEL_SELECTION.model,
                    config: {
                      "tools.update_plan.enabled": true,
                      mcp_optional_startup_grace_ms: 10_000,
                      "features.concurrent_reasoning_summaries": true,
                      "features.multi_agent": false,
                      "features.apps": false,
                      "features.plugins": false,
                      "features.browser_use": false,
                      "features.computer_use": false,
                      web_search: "disabled",
                      mcp_servers: {
                        inherited: { enabled: false },
                        browser: { enabled: false },
                        "t3-code": { enabled: false },
                      },
                    },
                  },
                },
              },
              withReplayRequestId(preamble[4]!, 3),
            ],
          }),
          undefined,
          {
            ...CODEX_TEST_RUNTIME_POLICY,
            managedAgent: true,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
          },
        );
        const thread = yield* session.ensureThread("managed-replay-thread");
        assert.equal(thread.nativeThreadRef?.nativeId, nativeThreadId);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          ),
        ),
      ),
  );
});

describe("CodexAdapterV2 post-settle continuation", () => {
  it.effect.each([
    { name: "original-account", before: "account-a", after: "account-a", expected: "account-a" },
    { name: "new-account", before: "account-b", after: "account-b", expected: "account-b" },
    { name: "changed-while-opening", before: "account-a", after: "account-b", expected: undefined },
  ])("binds streamed usage to the account of each session: $name", (scenario) =>
    Effect.gen(function* () {
      const nativeThreadId = `usage-identity-${scenario.name}`;
      const nativeTurnId = "usage-turn";
      const transcript = makeCodexReplayTranscript({
        scenario: nativeThreadId,
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" }),
          {
            type: "emit_inbound",
            label: "account/rateLimits/updated",
            frame: {
              method: "account/rateLimits/updated",
              params: {
                rateLimits: {
                  limitId: "codex",
                  primary: { usedPercent: 85, resetsAt: 2000100000, windowDurationMins: 300 },
                },
              },
            },
          },
          {
            type: "emit_inbound",
            label: "turn/completed",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
              },
            },
          },
        ],
      });
      const reads = yield* Ref.make(0);
      const reported =
        yield* Deferred.make<
          Parameters<NonNullable<CodexAdapterV2.CodexAdapterV2Options["onUsageLimits"]>>[0]
        >();
      const identity = Ref.updateAndGet(reads, (n) => n + 1).pipe(
        Effect.map((n) => (n === 1 ? scenario.before : scenario.after)),
      );
      const harness = yield* makeCodexReplayHarness(
        transcript,
        undefined,
        undefined,
        undefined,
        undefined,
        (report) => Deferred.succeed(reported, report),
        undefined,
        undefined,
        undefined,
        identity,
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(`usage-${scenario.name}`),
          text: "work",
        }),
      );
      const report = yield* Deferred.await(reported);
      assert.equal(report.credentialFingerprint, scenario.expected);
      assert.equal(yield* Ref.get(reads), 2);
      yield* harness.firstTerminal;
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  it.effect("delivers labeled video image inputs and skips vanished frames", () =>
    Effect.gen(function* () {
      const videoFs = yield* FileSystem.FileSystem;
      const videoDir = yield* videoFs.makeTempDirectoryScoped();
      const framePath = videoDir + "/frame.jpg";
      yield* videoFs.writeFile(framePath, Uint8Array.from([9, 10]));
      const videoFrames = [3200, 7200, 9000].map((timestampMs, index) => ({
        videoAttachmentId: "video" as never,
        videoName: "clip.mp4",
        timestampMs,
        path: index === 2 ? videoDir + "/missing.jpg" : framePath,
        mimeType: "image/jpeg" as const,
        sizeBytes: 2,
      }));

      const nativeThreadId = "video-thread";
      const nativeTurnId = "video-turn";
      const entries = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Watch" });
      const expected = [
        { type: "text", text: "Watch" },
        { type: "text", text: '[Frame of video "clip.mp4" at 00:03.200]' },
        { type: "image", url: "data:image/jpeg;base64,CQo=" },
        { type: "text", text: '[Frame of video "clip.mp4" at 00:07.200]' },
        { type: "image", url: "data:image/jpeg;base64,CQo=" },
      ];
      const transcript = makeCodexReplayTranscript({
        scenario: "video-frames",
        entries: entries.map((entry) => {
          if (entry.type === "expect_outbound" && entry.label === "turn/start") {
            return {
              ...entry,
              frame: {
                id: 3,
                method: "turn/start",
                params: {
                  threadId: nativeThreadId,
                  input: expected,
                  cwd: "/workspace",
                  model: "gpt-5.4",
                  approvalPolicy: "never",
                  approvalsReviewer: "user",
                  sandboxPolicy: { type: "dangerFullAccess" },
                  summary: "auto",
                  collaborationMode: {
                    mode: "default",
                    settings: { model: "gpt-5.4" },
                  },
                },
              },
            };
          }
          return entry;
        }),
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      const input = makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("video-attempt"),
        text: "Watch",
      });
      yield* harness.runtime.startTurn({ ...input, message: { ...input.message, videoFrames } });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );
});
