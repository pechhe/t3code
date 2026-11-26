// Fork cases for ClaudeAdapterV2 live here; upstream's own cases stay in ClaudeAdapterV2.test.ts.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";
import type { SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CLAUDE_COMPACT_RESERVE,
  ClaudeSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { type ClaudeModelCatalog } from "../../provider/ClaudeModelCatalog.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(ClaudeSdk.resolveSettings).mockReset().mockResolvedValue({
    effective: {},
    provenance: {},
    sources: [],
  });
});

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

const CLAUDE_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;

const CLAUDE_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeClaudeTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly title?: string;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: input.title ?? "Claude attachment test",
    providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
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

function makeClaudeTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
  readonly attachments: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"];
  readonly videoFrames?: ProviderAdapter.ProviderAdapterV2TurnMessage["videoFrames"];
  readonly providerTurnOrdinal?: number;
  readonly nativeThreadHasTurns?: boolean;
  readonly title?: string;
  readonly messageCreatedBy?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["createdBy"];
  readonly messageCreationSource?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["creationSource"];
  readonly modelSelection?: ModelSelection;
  readonly compaction?: ProviderAdapter.ProviderAdapterV2TurnInput["compaction"];
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeClaudeTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: input.providerTurnOrdinal ?? 1,
    ...(input.nativeThreadHasTurns === undefined
      ? {}
      : { nativeThreadHasTurns: input.nativeThreadHasTurns }),
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: input.attachments,
      videoFrames: input.videoFrames,
    },
    modelSelection: input.modelSelection ?? CLAUDE_TEST_MODEL_SELECTION,
    ...(input.compaction === undefined ? {} : { compaction: input.compaction }),
    runtimePolicy: input.runtimePolicy ?? CLAUDE_TEST_RUNTIME_POLICY,
  };
}

describe("ClaudeAdapterV2 runtime query policy", () => {
  it("lets a managed web-research agent search and fetch without approval", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        managedAgent: true,
        webResearch: true,
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "dontAsk",
      tools: [
        ...ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
        "WebSearch",
        "WebFetch",
        "ToolSearch",
      ],
      allowedTools: ["WebSearch", "WebFetch"],
      installPermissionCallback: false,
    });
  });
});

describe("ClaudeAdapterV2 MCP query overrides", () => {
  const mcpSessionFor = (
    threadId: ThreadId,
    authorizationHeader = "Bearer secret-claude-token",
  ): McpProviderSession.McpProviderSessionConfig => ({
    environmentId: EnvironmentId.make(`environment-${threadId}`),
    threadId,
    providerSessionId: `mcp-session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader,
    browserToolsAvailable: true,
  });

  it("attaches a managed task's own T3 endpoint, whichever class it is", () => {
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: {
        ...mcpSessionFor(ThreadId.make("thread-claude-mcp-managed")),
        endpoint: "http://127.0.0.1:43123/mcp/reader",
        delegated: true,
        listsPreview: false,
      },
      readOnlySandbox: true,
      managedAgent: true,
      allowedTools: ["Read"],
    });

    assert.deepEqual(overrides.allowedTools, ["Read", ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_WILDCARD]);
    assert.equal(
      overrides.mcpServers?.["t3-code"]?.type === "http"
        ? overrides.mcpServers["t3-code"].url
        : undefined,
      "http://127.0.0.1:43123/mcp/reader",
    );
  });

  it("keeps a delegated browser child's preview endpoint", () => {
    for (const session of [
      { endpoint: "http://127.0.0.1:43123/mcp/child-preview" },
      { endpoint: "http://127.0.0.1:43123/mcp/child-preview", listsDevice: true },
    ]) {
      const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
        mcpSession: {
          ...mcpSessionFor(ThreadId.make("thread-claude-mcp-preview-child")),
          delegated: true,
          listsPreview: true,
          ...session,
        },
        readOnlySandbox: true,
        managedAgent: true,
        allowedTools: ["Read"],
      });

      // Its credential reaches one child endpoint, whose own registry decides the tools, so the
      // wildcard pre-approves that endpoint and nothing else.
      assert.deepEqual(overrides.allowedTools, ["Read", "mcp__t3-code__*"]);
      assert.deepEqual(overrides.mcpServers, {
        "t3-code": {
          type: "http",
          url: session.endpoint,
          headers: { Authorization: "Bearer secret-claude-token" },
          timeout: ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
        },
      });
    }
  });

  it("gives a managed browser task only its endpoint's tools, never the wildcard", () => {
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: {
        ...mcpSessionFor(ThreadId.make("thread-claude-mcp-managed-browser")),
        endpoint: "http://127.0.0.1:43123/mcp/browser",
        managedBrowser: true,
      },
      readOnlySandbox: true,
      managedAgent: true,
      allowedTools: ["Read"],
    });

    assert.deepEqual(overrides.allowedTools, [
      "Read",
      ...ClaudeAdapterV2.CLAUDE_MANAGED_BROWSER_MCP_ALLOWED_TOOLS,
    ]);
    assert.notInclude(overrides.allowedTools ?? [], ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_WILDCARD);
    assert.notInclude(overrides.allowedTools ?? [], "mcp__t3-code__preview_evaluate");
    assert.deepEqual(Object.keys(overrides.mcpServers ?? {}), ["t3-code"]);
  });
});

describe("ClaudeAdapterV2 native protocol logging", () => {
  it("gives admitted trusted writers native edit and shell tools but no native delegation or inherited configuration", () => {
    const policy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/managed-workspace",
      managedAgent: true,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "trusted-session",
      resume: true,
      cwd: "/managed-workspace",
      managedAgent: true,
      ...policy,
      settings: {
        ...DEFAULT_CLAUDE_SETTINGS,
        launchArgs:
          "--permission-mode plan --mcp-config /inherited/config --settings /inherited/settings",
      },
      mcpServers: {},
      sdkSettings: {
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "unsafe" }] }] },
      } as never,
    });
    // A managed writer keeps the coding set; T3's own tools reach it through ToolSearch.
    assert.deepEqual(options.tools, [
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
      "Bash",
      "ToolSearch",
    ]);
    assert.notProperty(options, "disallowedTools");
    assert.notProperty(options.settings, "hooks");
    assert.equal(options.permissionMode, "bypassPermissions");
    assert.isTrue(options.allowDangerouslySkipPermissions);
    assert.equal(options.resume, "trusted-session");
    assert.deepEqual(options.settingSources, []);
    assert.deepEqual(options.plugins, []);
    assert.deepEqual(options.skills, []);
    assert.deepEqual(options.mcpServers, {});
    assert.isTrue(options.strictMcpConfig);
    assert.include(options.settings, { disableAllHooks: true });
    assert.isUndefined(options.extraArgs?.settings);
    assert.isUndefined(options.extraArgs?.["mcp-config"]);
  });

  it("refuses managed workspace-write and mismatched trusted modes before an SDK process opens", () => {
    for (const [runtimeMode, sandboxPolicy] of [
      [
        "full-access",
        { type: "workspaceWrite", writableRoots: ["/managed-workspace"], networkAccess: false },
      ],
      ["auto", { type: "dangerFullAccess" }],
      ["full-access", { type: "externalSandbox" }],
    ] as const) {
      assert.throws(
        () =>
          ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy({
            runtimeMode,
            interactionMode: "default",
            cwd: "/managed-workspace",
            managedAgent: true,
            approvalPolicy: "never",
            sandboxPolicy,
          }),
        /Managed Claude requires/,
      );
    }
  });

  it("keeps managed readonly SDK options isolated from conflicting launch permissions", () => {
    const policy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/managed-workspace",
      managedAgent: true,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "managed-claude-native",
      resume: false,
      cwd: "/managed-workspace",
      managedAgent: true,
      settings: {
        ...DEFAULT_CLAUDE_SETTINGS,
        launchArgs:
          "--permission-mode bypassPermissions --dangerously-skip-permissions --mcp-config /unsafe/config.json",
      },
      ...policy,
      mcpServers: {},
    });
    assert.deepEqual(options.settingSources, []);
    assert.deepEqual(options.skills, []);
    assert.deepEqual(options.plugins, []);
    assert.isTrue(options.strictMcpConfig);
    assert.equal(options.permissionMode, "dontAsk");
    assert.isUndefined(options.allowDangerouslySkipPermissions);
    assert.deepEqual(options.tools, ["Read", "Glob", "Grep", "ToolSearch"]);
    assert.deepEqual(options.mcpServers, {});
    assert.isUndefined(options.extraArgs?.["permission-mode"]);
    assert.isUndefined(options.extraArgs?.["dangerously-skip-permissions"]);
    assert.isUndefined(options.extraArgs?.["mcp-config"]);
  });
});

describe("ClaudeAdapterV2 background wake turns", () => {
  const WAKE_NATIVE_SESSION = "native-thread-claude-wake";

  function claudeSdkFrame(frame: unknown): SDKMessage {
    if (
      typeof frame !== "object" ||
      frame === null ||
      typeof Reflect.get(frame, "type") !== "string"
    ) {
      throw new Error("Frame is not a Claude Agent SDK message.");
    }
    return frame as SDKMessage;
  }

  const makeResultFrame = (input: {
    readonly uuid: string;
    readonly result: string;
    readonly numTurns?: number;
    readonly origin?: { readonly kind: "task-notification" };
    readonly subtype?: string;
    readonly isError?: boolean;
    readonly errors?: ReadonlyArray<string>;
    readonly apiErrorStatus?: number;
    // null omits the field, as the CLI does on a zero-turn result.
    readonly terminalReason?: SDKResultMessage["terminal_reason"] | null;
    readonly usage?: {
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly cache_creation_input_tokens: number;
      readonly cache_read_input_tokens: number;
    };
    readonly modelUsage?: SDKResultMessage["modelUsage"];
  }) =>
    claudeSdkFrame({
      type: "result",
      subtype: input.subtype ?? "success",
      duration_ms: 10,
      duration_api_ms: 10,
      is_error: input.isError ?? false,
      num_turns: input.numTurns ?? 1,
      result: input.result,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: input.usage ?? {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: input.modelUsage ?? {},
      permission_denials: [],
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.errors === undefined ? {} : { errors: input.errors }),
      ...(input.apiErrorStatus === undefined ? {} : { api_error_status: input.apiErrorStatus }),
      ...(input.terminalReason === null
        ? {}
        : { terminal_reason: input.terminalReason ?? "completed" }),
    });

  const wakeTurnInit = claudeSdkFrame({
    type: "system",
    subtype: "init",
    uuid: "00000000-0000-4000-8000-000000000110",
    session_id: WAKE_NATIVE_SESSION,
  });

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

  const makeWakeHarnessWithOptions = (options?: {
    readonly retainedTranscript?: boolean;
    readonly close?: (sdkMessages: Queue.Queue<SDKMessage>) => Effect.Effect<void>;
    readonly interrupt?: Effect.Effect<void, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
    readonly setPermissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["setPermissionMode"];
    readonly setModel?: (
      model: string,
      offerAndWait: (message: SDKMessage) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
    readonly renameSession?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["renameSession"];
    readonly applyFlagSettings?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["applyFlagSettings"];
    readonly stopTask?: (
      taskId: string,
    ) => Effect.Effect<void, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
    readonly backgroundTasks?: (
      toolUseId: string,
    ) => Effect.Effect<boolean, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
    readonly mcp?: Pick<
      ClaudeAdapterV2.ClaudeAgentSdkQuerySession,
      "mcpServerStatus" | "readMcpResource" | "callMcpTool"
    > &
      Partial<Pick<ClaudeAdapterV2.ClaudeAgentSdkQuerySession, "listPermissionRules">>;
    readonly environment?: NodeJS.ProcessEnv;
    readonly onSessionInit?: (cwd: string) => Effect.Effect<void>;
    readonly subagentLaunchToolUseId?: string;
    readonly subagentModel?: string;
    readonly nativeSessionId?: string;
    readonly settings?: ClaudeSettings;
    readonly modelCatalog?: Effect.Effect<ClaudeModelCatalog>;
    readonly freshQueueOnReopen?: boolean;
    readonly forkSession?: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape["forkSession"];
    readonly allocateSessionId?: Effect.Effect<string>;
    readonly offer?: (message: SDKUserMessage) => Effect.Effect<void>;
    readonly promptSuggestions?: boolean;
    readonly routeModelCatalog?: ClaudeAdapterV2.ClaudeAdapterV2Options["routeModelCatalog"];
  }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-claude-v2-wake-",
      });
      const claudeHome = `${attachmentsDir}/claude`;
      if (options?.retainedTranscript) {
        yield* fileSystem.makeDirectory(`${claudeHome}/projects/wake`, { recursive: true });
        for (const nativeId of [
          options?.nativeSessionId ?? WAKE_NATIVE_SESSION,
          "forked-native-session",
        ])
          yield* fileSystem.writeFileString(
            `${claudeHome}/projects/wake/${nativeId}.jsonl`,
            '{"type":"user","message":{"content":"Previous turn"}}\n',
          );
      }
      const sdkMessages = yield* Queue.unbounded<SDKMessage>();
      const processQueues: Array<Queue.Queue<SDKMessage>> = [];
      const processedMessages = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
      const offerAndWait = Effect.fnUntraced(function* (
        message: SDKMessage,
        offered?: Deferred.Deferred<void>,
      ) {
        const processed = yield* Deferred.make<void>();
        processedMessages.set(message, processed);
        yield* Queue.offer(processQueues.at(-1) ?? sdkMessages, message);
        if (offered !== undefined) yield* Deferred.succeed(offered, undefined);
        yield* Deferred.await(processed);
      });
      const changes = yield* makeChangeSignal;
      const offeredMessages: Array<SDKUserMessage> = [];
      const permissionModeChanges: Array<string> = [];
      const renameCalls: Array<string> = [];
      const liveSelectionChanges: Array<unknown> = [];
      const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
        [];
      const continuationReceipts =
        yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
      const terminalReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
        >();
      const subagentReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }>
        >();
      const systemNoticeReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>
        >();
      const runtimeRequestReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>
        >();
      const planReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "plan.updated" }>
        >();
      const providerThreadReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "provider_thread.updated" }>
        >();
      let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
      const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
        settings: options?.settings ?? DEFAULT_CLAUDE_SETTINGS,
        ...(options?.modelCatalog === undefined ? {} : { modelCatalog: options.modelCatalog }),
        environment: {
          ...options?.environment,
          ...(options?.retainedTranscript ? { CLAUDE_CONFIG_DIR: claudeHome } : {}),
        },
        attachmentsDir,
        fileSystem,
        path: yield* Path.Path,
        random: yield* SecureRandom.SecureRandom,
        idAllocator,
        ...(options?.onSessionInit ? { onSessionInit: options.onSessionInit } : {}),
        ...(options?.routeModelCatalog ? { routeModelCatalog: options.routeModelCatalog } : {}),
        continuationRequests: {
          offer: (request) =>
            Effect.sync(() => {
              continuationRequests.push(request);
            }).pipe(
              Effect.andThen(Queue.offer(continuationReceipts, request)),
              Effect.andThen(changes.notify),
            ),
        },
        queryRunner: {
          allocateSessionId:
            options?.allocateSessionId ??
            Effect.succeed(options?.nativeSessionId ?? WAKE_NATIVE_SESSION),
          open: (input) =>
            Effect.gen(function* () {
              openedOptions = input.options;
              const processMessages =
                options?.freshQueueOnReopen === true && processQueues.length > 0
                  ? yield* Queue.unbounded<SDKMessage>()
                  : sdkMessages;
              const messages = Stream.fromQueue(processMessages).pipe(
                Stream.flatMap((message) =>
                  Stream.make(message).pipe(
                    Stream.concat(
                      Stream.fromEffect(
                        Effect.suspend(() => {
                          const processed = processedMessages.get(message);
                          return processed === undefined
                            ? Effect.void
                            : Deferred.succeed(processed, undefined);
                        }),
                      ).pipe(Stream.drain),
                    ),
                  ),
                ),
              );
              if (options?.freshQueueOnReopen === true && processQueues.length > 0) {
                processQueues.push(processMessages);
                return {
                  messages,
                  offer: (message: SDKUserMessage) =>
                    Effect.sync(() => {
                      offeredMessages.push(message);
                    }).pipe(Effect.andThen(changes.notify)),
                  setModel: () => Effect.void,
                  mcpAuthenticate: () => Effect.die("unexpected MCP sign-in"),
                  mcpSubmitOAuthCallbackUrl: () => Effect.die("unexpected MCP sign-in"),
                  reconnectMcpServer: () => Effect.die("unexpected MCP reconnect"),
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: (mode) =>
                    Effect.sync(() => {
                      permissionModeChanges.push(mode);
                    }).pipe(
                      Effect.andThen(() => options?.setPermissionMode?.(mode) ?? Effect.void),
                    ),
                  renameSession: (title) =>
                    Effect.sync(() => {
                      renameCalls.push(title);
                    }).pipe(Effect.andThen(() => options?.renameSession?.(title) ?? Effect.void)),
                  backgroundTasks: options?.backgroundTasks ?? (() => Effect.succeed(false)),
                  mcpServerStatus: Effect.succeed([]),
                  readMcpResource: () => Effect.die("unexpected MCP resource read"),
                  callMcpTool: () => Effect.die("unexpected MCP tool call"),
                  listPermissionRules: Effect.die("unexpected permission rules read"),
                  stopTask: options?.stopTask ?? (() => Effect.void),
                  interrupt: Effect.void,
                  close: Queue.shutdown(processMessages),
                };
              }
              processQueues.push(sdkMessages);
              return {
                messages,
                offer: (message) =>
                  Effect.sync(() => {
                    offeredMessages.push(message);
                  }).pipe(
                    Effect.andThen(changes.notify),
                    Effect.andThen(options?.offer?.(message) ?? Effect.void),
                  ),
                setModel: (model) =>
                  Effect.sync(() => {
                    liveSelectionChanges.push({ model });
                  }).pipe(
                    Effect.andThen(() => options?.setModel?.(model, offerAndWait) ?? Effect.void),
                  ),
                mcpAuthenticate: () => Effect.die("unexpected MCP sign-in"),
                mcpSubmitOAuthCallbackUrl: () => Effect.die("unexpected MCP sign-in"),
                reconnectMcpServer: () => Effect.die("unexpected MCP reconnect"),
                applyFlagSettings: (settings) =>
                  Effect.sync(() => {
                    liveSelectionChanges.push(settings);
                  }).pipe(
                    Effect.andThen(() => options?.applyFlagSettings?.(settings) ?? Effect.void),
                  ),
                setPermissionMode: (mode) =>
                  Effect.sync(() => {
                    permissionModeChanges.push(mode);
                  }).pipe(Effect.andThen(() => options?.setPermissionMode?.(mode) ?? Effect.void)),
                renameSession: (title) =>
                  Effect.sync(() => {
                    renameCalls.push(title);
                  }).pipe(Effect.andThen(() => options?.renameSession?.(title) ?? Effect.void)),
                backgroundTasks: options?.backgroundTasks ?? (() => Effect.succeed(false)),
                mcpServerStatus: options?.mcp?.mcpServerStatus ?? Effect.succeed([]),
                readMcpResource:
                  options?.mcp?.readMcpResource ??
                  (() => Effect.die("unexpected MCP resource read")),
                callMcpTool:
                  options?.mcp?.callMcpTool ?? (() => Effect.die("unexpected MCP tool call")),
                listPermissionRules: options?.mcp?.listPermissionRules ?? Effect.succeed([]),
                stopTask: options?.stopTask ?? (() => Effect.void),
                interrupt: options?.interrupt ?? Effect.void,
                close: options?.close?.(sdkMessages) ?? Effect.void,
              };
            }),
          forkSession: options?.forkSession ?? (() => Effect.die("unused forkSession")),
          subagentLaunchToolUseId: () => Effect.succeed(options?.subagentLaunchToolUseId ?? null),
          subagentModel: () => Effect.succeed(options?.subagentModel ?? null),
          assertComplete: Effect.void,
        },
      });
      const threadId = ThreadId.make("thread-claude-wake");
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-claude-wake"),
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        promptSuggestions: Effect.succeed(options?.promptSuggestions === true),
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
      });
      const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const assistantItemReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>["turnItem"]
        >();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "turn_item.updated" && event.turnItem.type === "assistant_message") {
              yield* Queue.offer(assistantItemReceipts, event.turnItem);
            }
            if (event.type === "subagent.updated") {
              yield* Queue.offer(subagentReceipts, event);
            }
            if (event.type === "turn.terminal") {
              yield* Queue.offer(terminalReceipts, event);
            }
            if (event.type === "runtime_request.updated") {
              yield* Queue.offer(runtimeRequestReceipts, event);
            }
            if (event.type === "plan.updated") {
              yield* Queue.offer(planReceipts, event);
            }
            if (event.type === "provider_thread.updated") {
              yield* Queue.offer(providerThreadReceipts, event);
            }
            if (event.type === "turn_item.updated" && event.turnItem.type === "system_notice") {
              yield* Queue.offer(systemNoticeReceipts, event);
            }
            yield* changes.notify;
          }),
        ),
        Effect.forkScoped,
      );
      if (runtime.hasPendingBackgroundWork === undefined) {
        throw new Error("Claude adapter runtime must expose hasPendingBackgroundWork.");
      }
      const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
      const terminalEvents = () =>
        events.filter(
          (
            event,
          ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
            event.type === "turn.terminal",
        );
      return {
        adapter,
        attachmentsDir,
        runtime,
        providerThread,
        threadId,
        sdkMessages,
        processQueues,
        offerAndWait,
        offeredMessages,
        promptUuid: (index: number) => {
          const uuid = offeredMessages[index]?.uuid;
          if (uuid === undefined) throw new Error(`No prompt offered at index ${index}.`);
          return uuid;
        },
        permissionModeChanges,
        renameCalls,
        liveSelectionChanges,
        continuationRequests,
        continuationReceipts,
        events,
        assistantItemReceipts,
        terminalReceipts,
        subagentReceipts,
        systemNoticeReceipts,
        runtimeRequestReceipts,
        planReceipts,
        providerThreadReceipts,
        getOpenedOptions: () => openedOptions,
        terminalEvents,
        hasPendingBackgroundWork,
        until: changes.until,
        awaitTerminal: (count: number) => changes.until(() => terminalEvents().length >= count),
        awaitContinuation: (count: number) =>
          changes.until(() => continuationRequests.length >= count),
      };
    });
  const makeWakeHarness = makeWakeHarnessWithOptions();

  describe("compaction on another model", () => {
    const CONVERSATION = {
      instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
      model: "claude-sonnet-5-5",
    } satisfies ModelSelection;
    const CHEAP = {
      instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
      model: "claude-haiku-4-5",
    } satisfies ModelSelection;
    const COMPACT_AT = 300_000;
    const compactionItems = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
      events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "compaction"
          ? [event.turnItem]
          : [],
      );
    const startCompaction = (
      harness: Effect.Success<typeof makeWakeHarness>,
      ordinal: number,
      compaction: ProviderAdapter.ProviderAdapterV2TurnInput["compaction"],
      text = "/compact",
    ) =>
      harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: DateTime.makeUnsafe(0),
          attemptId: RunAttemptId.make(`attempt-cheap-compaction-${ordinal}`),
          text,
          attachments: [],
          providerTurnOrdinal: ordinal,
          modelSelection: CONVERSATION,
          ...(compaction === undefined ? {} : { compaction }),
          runtimePolicy: { ...CLAUDE_TEST_RUNTIME_POLICY, compactAt: COMPACT_AT },
        }),
      );
    const finishCompaction = Effect.fnUntraced(function* (
      harness: Effect.Success<typeof makeWakeHarness>,
      ordinal: number,
      outcome: "success" | "failed" = "success",
    ) {
      yield* harness.offerAndWait(claudeSdkFrame(wakeTurnInit));
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: `00000000-0000-4000-8000-0000000c0${ordinal}01`,
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* harness.offerAndWait(
        outcome === "success"
          ? claudeSdkFrame({
              type: "system",
              subtype: "compact_boundary",
              compact_metadata: { trigger: "manual", pre_tokens: 251_000, post_tokens: 12_000 },
              uuid: `00000000-0000-4000-8000-0000000c0${ordinal}02`,
              session_id: WAKE_NATIVE_SESSION,
            })
          : claudeSdkFrame({
              type: "system",
              subtype: "status",
              status: null,
              compact_result: "failed",
              compact_error: "Not enough messages to compact.",
              uuid: `00000000-0000-4000-8000-0000000c0${ordinal}02`,
              session_id: WAKE_NATIVE_SESSION,
            }),
      );
      yield* Queue.offer(
        harness.processQueues.at(-1)!,
        claudeSdkFrame({
          ...makeResultFrame({
            uuid: `00000000-0000-4000-8000-0000000c0${ordinal}03`,
            result: "",
            numTurns: 0,
            terminalReason: null,
          }),
          local_command: "compact",
        }),
      );
      yield* Queue.take(harness.terminalReceipts);
    });
    const provide = Effect.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        McpProviderSessions.layer,
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      ),
    );

    it.effect(
      "summarises on the chosen model while the thread's window, compact point and usage stay the conversation's",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          yield* startCompaction(harness, 1, { modelSelection: CHEAP });
          const opened = harness.getOpenedOptions();
          assert.equal(opened?.model, "claude-haiku-4-5");
          // The conversation's 1M window bounds the point; Haiku's 200k window would clamp it.
          assert.equal(
            (opened?.settings as { autoCompactWindow?: number } | undefined)?.autoCompactWindow,
            COMPACT_AT + CLAUDE_COMPACT_RESERVE,
          );
          yield* finishCompaction(harness, 1);

          const [, settled] = compactionItems(harness.events);
          assert.equal(settled?.status, "completed");
          assert.equal(settled?.model, "claude-haiku-4-5");
          assert.equal(settled?.beforeTokenCount, 251_000);
          assert.equal(settled?.afterTokenCount, 12_000);
          const usages = harness.events.flatMap((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.tokenUsage
              ? [event.providerTurn.tokenUsage]
              : [],
          );
          assert.isNotEmpty(usages);
          for (const usage of usages) {
            assert.equal(usage.maxTokens, 1_000_000);
            assert.equal(usage.autoCompactThreshold, COMPACT_AT);
            assert.equal(usage.compactedWith, "claude-haiku-4-5");
          }
        }).pipe(Effect.scoped, provide),
    );

    it.effect("names the chosen model on a compaction that fails after it starts", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* startCompaction(harness, 1, { modelSelection: CHEAP });
        yield* finishCompaction(harness, 1, "failed");
        const items = compactionItems(harness.events);
        assert.deepEqual(
          items.map((item) => [item.status, item.model]),
          [
            ["running", "claude-haiku-4-5"],
            ["failed", "claude-haiku-4-5"],
          ],
        );
        // The failure never retries on the conversation's model.
        assert.lengthOf(harness.processQueues, 1);
        assert.equal(harness.getOpenedOptions()?.model, "claude-haiku-4-5");
      }).pipe(Effect.scoped, provide),
    );

    it.effect(
      "summarises on the conversation's model and says so when the window is too small",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          yield* startCompaction(harness, 1, { windowTooSmall: true });
          assert.equal(harness.getOpenedOptions()?.model, "claude-sonnet-5-5");
          yield* finishCompaction(harness, 1);
          const [, settled] = compactionItems(harness.events);
          assert.equal(settled?.windowTooSmall, true);
          assert.isUndefined(settled?.model);
        }).pipe(Effect.scoped, provide),
    );

    it.effect("opens for the conversation's model as always when nothing is chosen", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* startCompaction(harness, 1, undefined);
        assert.equal(harness.getOpenedOptions()?.model, "claude-sonnet-5-5");
        yield* finishCompaction(harness, 1);
        const [, settled] = compactionItems(harness.events);
        assert.isUndefined(settled?.model);
        assert.isUndefined(settled?.windowTooSmall);
        for (const event of harness.events) {
          if (event.type === "provider_turn.updated") {
            assert.isUndefined(event.providerTurn.tokenUsage?.compactedWith);
          }
        }
      }).pipe(Effect.scoped, provide),
    );

    const finishNormalTurn = Effect.fnUntraced(function* (
      harness: Effect.Success<typeof makeWakeHarness>,
      ordinal: number,
    ) {
      yield* harness.offerAndWait(claudeSdkFrame(wakeTurnInit));
      yield* Queue.offer(
        harness.processQueues.at(-1)!,
        makeResultFrame({
          uuid: `00000000-0000-4000-8000-0000000c0${ordinal}99`,
          result: "Done.",
        }),
      );
      yield* Queue.take(harness.terminalReceipts);
    });
    const modelChanges = (harness: Effect.Success<typeof makeWakeHarness>) =>
      harness.liveSelectionChanges.flatMap((change) =>
        typeof change === "object" && change !== null && "model" in change ? [change.model] : [],
      );

    it.effect("switches the live session to the chosen model and back for the next turn", () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const OPUS = { ...CONVERSATION, model: "claude-opus-5-5" };
        yield* startCompaction(harness, 1, undefined, "Continue.");
        yield* finishNormalTurn(harness, 1);
        yield* startCompaction(harness, 2, { modelSelection: OPUS });
        yield* finishCompaction(harness, 2);
        yield* startCompaction(harness, 3, undefined, "Next message.");
        assert.deepEqual(modelChanges(harness), ["claude-opus-5-5", "claude-sonnet-5-5"]);
        assert.lengthOf(harness.processQueues, 1);
      }).pipe(Effect.scoped, provide),
    );

    it.effect(
      "leaves the thread on the conversation's model when a compaction on the chosen model is interrupted",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeWakeHarnessWithOptions({
            close: (sdkMessages) => Queue.shutdown(sdkMessages),
            freshQueueOnReopen: true,
          });
          const OPUS = { ...CONVERSATION, model: "claude-opus-5-5" };
          yield* startCompaction(harness, 1, undefined, "Continue.");
          yield* finishNormalTurn(harness, 1);
          yield* startCompaction(harness, 2, { modelSelection: OPUS });
          yield* harness.offerAndWait(
            claudeSdkFrame({
              type: "system",
              subtype: "status",
              status: "compacting",
              uuid: "00000000-0000-4000-8000-0000000c0201",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: "turn:attempt-cheap-compaction-2",
            }),
          });
          assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "interrupted");
          assert.deepEqual(
            compactionItems(harness.events).map((item) => [item.status, item.model]),
            [
              ["running", "claude-opus-5-5"],
              ["interrupted", "claude-opus-5-5"],
            ],
          );

          // The next turn goes back to the conversation's model, never the interrupted one.
          yield* startCompaction(harness, 3, undefined, "Next message.");
          assert.equal(harness.getOpenedOptions()?.model, "claude-sonnet-5-5");
        }).pipe(Effect.scoped, provide),
    );

    it.effect(
      "reopens the session for a chosen model that cannot be applied live, keeping the conversation's compact window",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeWakeHarnessWithOptions({ freshQueueOnReopen: true });
          const openedWindow = () =>
            (harness.getOpenedOptions()?.settings as { autoCompactWindow?: number } | undefined)
              ?.autoCompactWindow;
          yield* startCompaction(harness, 1, undefined, "Continue.");
          yield* finishNormalTurn(harness, 1);
          assert.lengthOf(harness.processQueues, 1);

          yield* startCompaction(harness, 2, { modelSelection: CHEAP });
          assert.lengthOf(harness.processQueues, 2);
          assert.equal(harness.getOpenedOptions()?.model, "claude-haiku-4-5");
          assert.equal(openedWindow(), COMPACT_AT + CLAUDE_COMPACT_RESERVE);
          yield* finishCompaction(harness, 2);

          // Switching back to the conversation's model needs no second process.
          yield* startCompaction(harness, 3, undefined, "Next message.");
          assert.lengthOf(harness.processQueues, 2);
        }).pipe(Effect.scoped, provide),
    );
  });
});
