// Fork cases for CodexAdapterV2 live here; upstream's own cases stay in CodexAdapterV2.test.ts.
import * as AgentMcpServers from "@t3tools/provider-core/server/AgentMcpServers";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  EnvironmentId,
  MessageId,
  type OrchestrationV2RuntimeRequest,
  ProviderTurnId,
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
import type * as CodexSchema from "effect-codex-app-server/schema";
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
import { TestClock } from "effect/testing";

import packageJson from "../../../package.json" with { type: "json" };
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { MANAGED_BROWSER_TOOL_NAMES } from "../../mcp/toolkits/browser/toolNames.ts";
import * as SlipJayGuard from "../../project/SlipJayGuard.ts";
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

const CODEX_TEST_THREAD_TITLE = "Codex continuation test";
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
    title: CODEX_TEST_THREAD_TITLE,
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

/**
 * Every turn/start follows a config/read, and a thread's first turn on a connection names it
 * unless the transcript names it itself. A thread start, resume or fork follows a config/read
 * unless it retries a failed request or the transcript reads config itself. Inserts those
 * exchanges and shifts later client ids.
 */
function withConfigReadBeforeTurnStart(
  entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
  threadName = CODEX_TEST_THREAD_TITLE,
): Array<CodexReplay.CodexAppServerReplayEntry> {
  const result: Array<CodexReplay.CodexAppServerReplayEntry> = [];
  let offset = 0;
  let clientIds = new Map<number, number>();
  let namedThreads = new Set<unknown>();
  let transcriptReads = 0;
  let previousOutbound: { readonly method: string; readonly id: number } | undefined;
  let failedMethod: string | undefined;
  for (const entry of entries) {
    const frame = entry.type === "runtime_exit" ? undefined : entry.frame;
    if (!Predicate.isObject(frame) || typeof frame.id !== "number") {
      result.push(entry);
      continue;
    }
    if (entry.type === "expect_outbound" && typeof frame.method === "string") {
      const params = Predicate.isObject(frame.params) ? frame.params : {};
      if (frame.method === "initialize") {
        offset = 0;
        clientIds = new Map();
        namedThreads = new Set();
      }
      if (frame.method === "thread/name/set") namedThreads.add(params.threadId);
      const exchanges: Array<readonly [string, unknown, unknown]> = [];
      const isThreadRequest =
        frame.method === "thread/start" ||
        frame.method === "thread/resume" ||
        frame.method === "thread/fork";
      if (frame.method === "config/read") transcriptReads += 1;
      else if (isThreadRequest && transcriptReads > 0) transcriptReads -= 1;
      else if (
        isThreadRequest &&
        failedMethod !== frame.method &&
        previousOutbound?.method !== "thread/unarchive"
      ) {
        exchanges.push([
          "config/read",
          { ...(params.cwd === undefined ? {} : { cwd: params.cwd }), includeLayers: false },
          { config: {}, origins: {} },
        ]);
      }
      if (frame.method === "turn/start") {
        if (!namedThreads.has(params.threadId)) {
          namedThreads.add(params.threadId);
          exchanges.push(["thread/name/set", { threadId: params.threadId, name: threadName }, {}]);
        }
        exchanges.push([
          "config/read",
          { cwd: params.cwd, includeLayers: false },
          { config: {}, origins: {} },
        ]);
      }
      for (const [method, requestParams, response] of exchanges) {
        const id = frame.id + offset;
        result.push(
          {
            type: "expect_outbound",
            label: method,
            frame: { id, method, params: requestParams },
          },
          { type: "emit_inbound", label: method, frame: { id, result: response } },
        );
        offset += 1;
      }
      previousOutbound = { method: frame.method, id: frame.id };
      failedMethod = undefined;
      clientIds.set(frame.id, frame.id + offset);
      result.push(withReplayRequestId(entry, frame.id + offset));
      continue;
    }
    if (entry.type === "emit_inbound" && frame.id === previousOutbound?.id && "error" in frame) {
      failedMethod = previousOutbound.method;
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

  it("injects cwd, model, and MCP authorization into thread-scoped params", () => {
    const threadId = ThreadId.make("thread-codex-mcp");
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-codex-mcp"),
      threadId,
      providerSessionId: "mcp-session-codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-codex-token",
      browserToolsAvailable: true,
    };

    assert.deepEqual(
      CodexAdapterV2.codexThreadRuntimeParams({
        mcpSession,
        modelSelection: { model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace/thread-codex-mcp",
        },
      }),
      {
        cwd: "/workspace/thread-codex-mcp",
        model: "gpt-5.4",
        config: {
          "tools.update_plan.enabled": true,
          // Codex waits up to 10 s, not 1 s, for MCP servers before the first request.
          mcp_optional_startup_grace_ms: 10_000,
          "features.concurrent_reasoning_summaries": true,
          "features.multi_agent": false,
          "features.apps": false,
          "features.plugins": false,
          "features.browser_use": false,
          "features.computer_use": false,
          web_search: "disabled",
          "mcp_servers.t3-code-direct": {
            url: "http://127.0.0.1:43123/mcp",
            tool_timeout_sec: 3_900,
            default_tools_approval_mode: "approve",
            enabled_tools: ["t3_thread_wait", "delegate_task"],
            omit_tools_from: ["code_mode", "deferred"],
            http_headers: { Authorization: "Bearer secret-codex-token" },
          },
          "mcp_servers.t3-code": {
            disabled_tools: ["t3_thread_wait", "delegate_task"],
            url: "http://127.0.0.1:43123/mcp",
            tool_timeout_sec: 3_900,
            // Claude pre-approves its wildcard, so Codex pre-approves the same server instead
            // of asking for each T3 tool (or denying it under `approval_policy: never`).
            default_tools_approval_mode: "approve",
            http_headers: {
              Authorization: "Bearer secret-codex-token",
            },
          },
        },
      },
    );
  });
});

describe("CodexAdapterV2 session initialize", () => {
  // Config keys the adapter fills in per thread; the assertions below read the recorded
  // requests instead, which is what the shared-session bug turned on.
  const managedThreadConfigKeys = [
    "features.multi_agent",
    "features.apps",
    "features.plugins",
    "features.browser_use",
    "features.computer_use",
    "web_search",
    "shell_environment_policy",
  ];

  // A managed thread reads the app-server's effective config before it starts.
  const managedConfigRead = (id: number): Array<CodexReplay.CodexAppServerReplayEntry> => [
    {
      type: "expect_outbound",
      label: "config/read",
      frame: {
        id,
        method: "config/read",
        params: { cwd: "/workspace", includeLayers: false },
      },
    },
    {
      type: "emit_inbound",
      label: "config/read",
      frame: { id, result: { config: { mcp_servers: {} }, origins: {} } },
    },
  ];

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

  it.effect(
    "gives a managed task a TMPDIR of its own for its turn and removes it when the turn ends",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-sandbox-tmp-" });
        const sandboxTempRoot = `${parent}/task`;
        const nativeThreadId = "managed-sandbox-temp-native";
        const prompt = "make a temp file";
        const runtimePolicy = {
          ...CODEX_TEST_RUNTIME_POLICY,
          managedAgent: true,
          sandboxTempRoot,
        };
        const holdCompletion = yield* Deferred.make<void>();
        const terminal = yield* Deferred.make<void>();
        const session = yield* openReplaySession(
          {
            ...makeCodexReplayTranscript({
              scenario: "managed-sandbox-temp",
              entries: (() => {
                const preamble = codexReplayPreamble({
                  nativeThreadId,
                  nativeTurnId: "turn-1",
                  prompt,
                });
                return [
                  ...preamble.slice(0, 3),
                  ...managedConfigRead(2),
                  withReplayRequestId(preamble[3]!, 3),
                  withReplayRequestId(preamble[4]!, 3),
                  withReplayRequestId(preamble[5]!, 4),
                  withReplayRequestId(preamble[6]!, 4),
                  preamble[7]!,
                  {
                    type: "emit_inbound",
                    label: "turn/completed",
                    frame: {
                      method: "turn/completed",
                      params: {
                        threadId: nativeThreadId,
                        turn: makeCodexReplayTurn({ id: "turn-1", status: "completed" }),
                      },
                    },
                  },
                ];
              })(),
            }),
            metadata: { recorderThreadConfigKeys: managedThreadConfigKeys },
          },
          (entry) =>
            entry.label === "turn/completed" ? Deferred.await(holdCompletion) : Effect.void,
          runtimePolicy,
        );
        const providerThread = yield* session.ensureThread(nativeThreadId);

        // The app-server is shared with every other task, so no task's directory rides in its
        // environment; the thread's own config names it.
        assert.isUndefined(session.environment()?.TMPDIR);
        const started = (session.requests().find((request) => request.method === "thread/start")
          ?.params ?? {}) as {
          config?: Record<string, unknown>;
        };
        assert.deepEqual(started.config?.shell_environment_policy, {
          set: { TMPDIR: sandboxTempRoot },
        });
        assert.isFalse(yield* fs.exists(sandboxTempRoot));

        yield* session.runtime.events.pipe(
          Stream.runForEach((event) =>
            event.type === "turn.terminal" ? Deferred.succeed(terminal, undefined) : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* session.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: session.threadId,
            providerThread,
            runtimePolicy,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("sandbox-temp-attempt"),
            text: prompt,
          }),
        );
        assert.equal((yield* fs.stat(sandboxTempRoot)).type, "Directory");

        yield* Deferred.succeed(holdCompletion, undefined);
        yield* Deferred.await(terminal);
        // Gone with the turn, not with the provider session.
        assert.isFalse(yield* fs.exists(sandboxTempRoot));
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

  it.effect("removes a managed task's temp dir when its turn never starts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-sandbox-tmp-" });
      const sandboxTempRoot = `${parent}/task`;
      const nativeThreadId = "managed-sandbox-temp-refused";
      const prompt = "make a temp file";
      const runtimePolicy = {
        ...CODEX_TEST_RUNTIME_POLICY,
        managedAgent: true,
        sandboxTempRoot,
      };
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId: "turn-1", prompt });
      const session = yield* openReplaySession(
        {
          ...makeCodexReplayTranscript({
            scenario: "managed-sandbox-temp-refused",
            entries: [
              ...preamble.slice(0, 3),
              ...managedConfigRead(2),
              withReplayRequestId(preamble[3]!, 3),
              withReplayRequestId(preamble[4]!, 3),
              withReplayRequestId(preamble[5]!, 4),
              {
                type: "emit_inbound",
                label: "turn/start",
                frame: { id: 4, error: { code: -32603, message: "turn start rejected" } },
              },
            ],
          }),
          metadata: { recorderThreadConfigKeys: managedThreadConfigKeys },
        },
        undefined,
        runtimePolicy,
      );
      const providerThread = yield* session.ensureThread(nativeThreadId);
      const failure = yield* session.runtime
        .startTurn(
          makeCodexTestTurnInput({
            threadId: session.threadId,
            providerThread,
            runtimePolicy,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("sandbox-temp-refused"),
            text: prompt,
          }),
        )
        .pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterTurnStartError");
      assert.isFalse(yield* fs.exists(sandboxTempRoot));
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

  it.effect("gives each managed thread on a shared app-server its own TMPDIR", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-sandbox-tmp-" });
      const firstRoot = `${parent}/first`;
      const secondRoot = `${parent}/second`;
      const firstThread = "shared-session-first";
      const secondThread = "shared-session-second";
      const session = yield* openReplaySession(
        {
          ...makeCodexReplayTranscript({
            scenario: "managed-shared-session-tmpdirs",
            entries: (() => {
              const first = replayPreamble(firstThread);
              const second = replayPreamble(secondThread);
              return [
                ...first.slice(0, 3),
                ...managedConfigRead(2),
                withReplayRequestId(first[3]!, 3),
                withReplayRequestId(first[4]!, 3),
                // ProviderSessionManager attaches a second app thread to the existing session
                // rather than opening another one, so its thread starts on the same app-server.
                ...managedConfigRead(4),
                withReplayRequestId(second[3]!, 5),
                withReplayRequestId(second[4]!, 5),
              ];
            })(),
          }),
          metadata: { recorderThreadConfigKeys: managedThreadConfigKeys },
        },
        undefined,
        {
          ...CODEX_TEST_RUNTIME_POLICY,
          managedAgent: true,
          sandboxTempRoot: firstRoot,
        },
      );
      yield* session.ensureThread(firstThread);
      yield* session.ensureThread(secondThread, {
        ...CODEX_TEST_RUNTIME_POLICY,
        managedAgent: true,
        sandboxTempRoot: secondRoot,
      });

      const tmpdirs = session
        .requests()
        .filter((request) => request.method === "thread/start")
        .map(
          (request) =>
            (
              (request.params as { config?: Record<string, unknown> }).config as {
                shell_environment_policy?: { set?: { TMPDIR?: string } };
              }
            ).shell_environment_policy?.set?.TMPDIR,
        );
      assert.deepEqual(tmpdirs, [firstRoot, secondRoot]);
      // Neither came from the process environment, which every task on the session shares.
      assert.isUndefined(session.environment()?.TMPDIR);
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

  it.effect.each(["canonical", "legacy"] as const)(
    "starts a thread with %s agent MCP registration",
    (registration) =>
      Effect.gen(function* () {
        const scenario = "agent-mcp";
        const threadId = ThreadId.make("thread-agent-mcp");
        const url = "https://agent-mcp.example.test/mcp";
        const authorizationHeader = "Bearer fixture-token";
        const agentMcp = Layer.succeed(AgentMcpServers.AgentMcpServers, {
          read: (id, mode) =>
            Effect.succeed(
              id === threadId
                ? (mode === "legacy" ? ["fixture", "fixture-legacy"] : ["fixture"]).map((name) => ({
                    name,
                    url,
                    authorizationHeader,
                  }))
                : [],
            ),
        });

        const nativeThreadId = "weave-thread";
        const nativeTurnId = "weave-turn";
        const prompt = "Record the review in Weave.";
        const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...preamble.map((entry) =>
              entry.type === "expect_outbound" && entry.label === "thread/start"
                ? {
                    ...entry,
                    frame: {
                      id: 2,
                      method: "thread/start",
                      params: {
                        config: {
                          ...CodexAdapterV2.CODEX_THREAD_CONFIG,
                          mcp_servers: Object.fromEntries(
                            (registration === "legacy"
                              ? ["fixture", "fixture-legacy"]
                              : ["fixture"]
                            ).map((name) => [
                              name,
                              {
                                url,
                                http_headers: { Authorization: authorizationHeader },
                                default_tools_approval_mode: "approve",
                              },
                            ]),
                          ),
                        },
                      },
                    },
                  }
                : entry,
            ),
            {
              type: "emit_inbound",
              label: "done",
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
        const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method, params) => Effect.sync(() => void requests.push({ method, params })),
        ).pipe(Effect.provide(agentMcp));
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("weave-attempt"),
            text: prompt,
          }),
        );
        yield* harness.firstTerminal;
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.deepEqual(
          requests.map(({ method }) => method),
          [
            "initialize",
            "config/read",
            "thread/start",
            "thread/name/set",
            "config/read",
            "turn/start",
          ],
        );
      }).pipe(
        Effect.provideService(AgentMcpServers.CurrentRegistration, registration),
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

  it.effect.each(["failed", "interrupted", "Stop"] as const)(
    "settles unfinished compaction on %s without changing completed compaction",
    (outcome) =>
      Effect.gen(function* () {
        const nativeThreadId = "compact-thread";
        const nativeTurnId = "compact-turn";
        const error = {
          message: "Remote compaction stream disconnected",
          codexErrorInfo: "other",
          additionalDetails: null,
        };
        const transcript = makeCodexReplayTranscript({
          scenario: `automatic-compaction-${outcome}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Continue." }),
            ...(
              [
                { method: "item/started", id: "completed-item", startedAtMs: 1782622441000 },
                { method: "item/completed", id: "completed-item", completedAtMs: 1782622442000 },
                { method: "item/started", id: "unfinished-item", startedAtMs: 1782622443000 },
              ] as const
            ).map(({ method, id, ...timestamps }) => ({
              type: "emit_inbound" as const,
              label: `${method}/${id}`,
              frame: {
                method,
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: { type: "contextCompaction", id },
                  ...timestamps,
                },
              },
            })),
            ...(outcome === "Stop"
              ? [
                  {
                    type: "expect_outbound" as const,
                    label: "turn/interrupt",
                    frame: {
                      id: 4,
                      method: "turn/interrupt",
                      params: { threadId: nativeThreadId, turnId: nativeTurnId },
                    },
                  },
                  {
                    type: "emit_inbound" as const,
                    label: "turn/interrupt/failed",
                    frame: { id: 4, error: { code: -32_000, message: "Interrupt failed" } },
                  },
                ]
              : [
                  {
                    type: "emit_inbound" as const,
                    label: "turn/completed",
                    frame: {
                      method: "turn/completed",
                      params: {
                        threadId: nativeThreadId,
                        turn: {
                          ...makeCodexReplayTurn({ id: nativeTurnId, status: outcome }),
                          error: outcome === "failed" ? error : null,
                        },
                      },
                    },
                  },
                ]),
          ],
        });
        const compactionStarted = yield* Deferred.make<ProviderTurnId>();
        const harness = yield* makeCodexReplayHarness(transcript, (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "unfinished-item" &&
          event.turnItem.status === "running" &&
          event.turnItem.providerTurnId !== null
            ? Deferred.succeed(compactionStarted, event.turnItem.providerTurnId)
            : Effect.void,
        );
        yield* TestClock.setTime(1782622445000);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`compact-${outcome}-attempt`),
            text: "Continue.",
          }),
        );
        if (outcome === "Stop") {
          const providerTurnId = yield* Deferred.await(compactionStarted);
          const interrupt = yield* harness.runtime
            .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
            .pipe(Effect.exit);
          assert.equal(interrupt._tag, "Failure");
        }
        yield* harness.firstTerminal;
        const items = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        );
        const completed = items.filter((item) => item.nativeItemRef?.nativeId === "completed-item");
        const unfinished = items.filter(
          (item) => item.nativeItemRef?.nativeId === "unfinished-item",
        );
        const status = outcome === "failed" ? "failed" : "interrupted";
        assert.deepEqual(
          unfinished.map((item) => item.status),
          ["running", status],
        );
        assert.equal(unfinished[0]?.id, unfinished[1]?.id);
        assert.deepEqual(unfinished[1]?.startedAt, DateTime.makeUnsafe(1782622443000));
        assert.deepEqual(
          unfinished[1]?.completedAt,
          DateTime.makeUnsafe(outcome === "Stop" ? 1782622445000 : 1782622450000),
        );
        assert.deepEqual(
          completed.map((item) => item.status),
          ["running", "completed"],
        );
        assert.deepEqual(completed[1]?.startedAt, DateTime.makeUnsafe(1782622441000));
        assert.deepEqual(completed[1]?.completedAt, DateTime.makeUnsafe(1782622442000));
        assert.equal(harness.terminalEvents()[0]?.status, status);
        if (outcome === "failed") {
          assert.equal(harness.terminalEvents()[0]?.failure?.message, error.message);
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
            NodeCrypto.layer,
          ),
        ),
      ),
  );

  describe("CodexAdapterV2 SlipJay guard", () => {
    const nativeThreadId = "thread-codex-guard";
    const nativeTurnId = "turn-codex-guard";
    const prompt = "Push the branch.";

    const turnStarted: CodexReplay.CodexAppServerReplayEntry = {
      type: "emit_inbound",
      label: "turn started",
      frame: {
        method: "turn/started",
        params: {
          threadId: nativeThreadId,
          turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
        },
      },
    };

    it.effect("declines a guarded command with SlipJay's message and never asks the user", () => {
      const seen: Array<SlipJayGuard.SlipJayGuardInput> = [];
      return Effect.scoped(
        Effect.gen(function* () {
          yield* FileSystem.FileSystem;
          yield* IdAllocator.IdAllocatorV2;
          yield* ProviderReplayHarness.makeReplayServerConfig("codex-guard").pipe(Effect.orDie);
          const transcript = makeCodexReplayTranscript({
            scenario: "codex-guard",
            entries: [
              // A governed workspace asks for approval in full access so the guard sees
              // every command; the rest of the preamble is unchanged.
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }).map((entry) => {
                if (entry.type !== "expect_outbound" || entry.label !== "turn/start") return entry;
                const frame = entry.frame as { params: Record<string, unknown> };
                return {
                  ...entry,
                  frame: { ...frame, params: { ...frame.params, approvalPolicy: "untrusted" } },
                };
              }),
              turnStarted,
              {
                type: "emit_inbound",
                label: "guarded command approval",
                frame: {
                  id: 100,
                  method: "item/commandExecution/requestApproval",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    itemId: "guarded-command",
                    command: "git push origin main",
                    cwd: "/workspace",
                  },
                },
              },
              // The guard answers before the user is ever asked: Codex gets a plain decline.
              {
                type: "expect_outbound",
                label: "guarded command decision",
                frame: { id: 100, result: { decision: "decline" } },
              },
              // An allowed command is accepted once, never for the session: Codex must
              // ask again next time, because a jj verdict moves with the working copy.
              {
                type: "emit_inbound",
                label: "allowed command approval",
                frame: {
                  id: 101,
                  method: "item/commandExecution/requestApproval",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    itemId: "allowed-command",
                    command: "git status",
                    cwd: "/workspace",
                  },
                },
              },
              {
                type: "expect_outbound",
                label: "allowed command decision",
                frame: { id: 101, result: { decision: "accept" } },
              },
              {
                type: "emit_inbound",
                label: "turn completed",
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
          const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
          const harness = yield* makeCodexReplayHarness(transcript, (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("codex-guard-attempt"),
              text: prompt,
            }),
          );
          yield* harness.firstTerminal;

          assert.deepStrictEqual(seen, [
            { cwd: "/workspace", command: "git push origin main" },
            { cwd: "/workspace", command: "git status" },
          ]);
          const declined = events.flatMap((event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "resolved"
              ? [event.runtimeRequest]
              : [],
          );
          assert.lengthOf(declined, 1);
          assert.equal(declined[0]!.decision, "decline");
          assert.isFalse(
            events.some(
              (event) =>
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.status === "pending",
            ),
          );
          const shownPrompts = events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request"
              ? [event.turnItem.prompt]
              : [],
          );
          assert.deepStrictEqual(shownPrompts, ["Use `slipjay land` instead."]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              McpProviderSessions.layer,
              Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
              Layer.succeed(SlipJayGuard.SlipJayGuard, {
                check: (input: SlipJayGuard.SlipJayGuardInput) =>
                  Effect.sync(() => {
                    seen.push(input);
                    return input.command === "git status"
                      ? { allowed: true, reason: null }
                      : { allowed: false, reason: "Use `slipjay land` instead." };
                  }),
                governs: () => Effect.succeed(true),
              }),
            ),
          ),
        ),
      );
    });
  });
});

describe("CodexAdapterV2 runtime policy", () => {
  it.effect(
    "carries a managed writer's network access into Codex and withholds it from a reader",
    () =>
      Effect.gen(function* () {
        const build = (sandboxPolicy: unknown) =>
          CodexAdapterV2.buildCodexTurnStartParams({
            nativeThreadId: "native-managed-sandbox",
            codexInput: [{ type: "text", text: "test" }],
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
              managedAgent: true,
              approvalPolicy: "never",
              sandboxPolicy,
            },
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4",
            },
          });

        const writer = yield* build({
          type: "workspaceWrite",
          writableRoots: ["/workspace"],
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        });
        assert.deepEqual(writer.sandboxPolicy, {
          type: "workspaceWrite",
          writableRoots: ["/workspace"],
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        });

        const reader = yield* build({ type: "readOnly", networkAccess: false });
        assert.deepEqual(reader.sandboxPolicy, { type: "readOnly", networkAccess: false });
      }),
  );

  it.effect("sends only the thread's own instruction variant as application context", () =>
    Effect.gen(function* () {
      const policy = { runtimeMode: "full-access", interactionMode: "default", cwd: null } as const;
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
      const turn = (text?: string) =>
        CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: "native-instruction",
          codexInput: [{ type: "text", text: "next step" }],
          runtimePolicy: policy,
          modelSelection,
          hasT3Mcp: true,
          ...(text === undefined ? {} : { instructionOverlay: { text, sha256: "a".repeat(64) } }),
        });
      const terse = yield* turn("Keep each reply under five lines.");
      const thorough = yield* turn("Explain each decision in full.");
      assert.deepEqual(terse.additionalContext?.["t3_instruction_experiment"], {
        kind: "application",
        value: "Keep each reply under five lines.",
      });
      assert.deepEqual(thorough.additionalContext?.["t3_instruction_experiment"], {
        kind: "application",
        value: "Explain each decision in full.",
      });
      assert.isDefined(terse.additionalContext?.["t3_code_runtime"]);
      assert.isUndefined((yield* turn()).additionalContext?.["t3_instruction_experiment"]);
    }),
  );
});

describe("CodexAdapterV2 auto-compaction", () => {
  const params = (autoCompactWindow?: string) =>
    CodexAdapterV2.codexThreadRuntimeParams({
      mcpSession: undefined,
      ...(autoCompactWindow === undefined ? {} : { autoCompactWindow }),
    }).config;

  it("sets Codex's compaction limit from the provider setting", () => {
    const config = params("300000");
    assert.equal(config.model_auto_compact_token_limit, 300_000);
    assert.equal(config.model_auto_compact_token_limit_scope, "total");
  });

  it("lets a thread's compact-at point override the provider setting", () => {
    const config = CodexAdapterV2.codexThreadRuntimeParams({
      mcpSession: undefined,
      autoCompactWindow: "300000",
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: null,
        compactAt: 180_000,
      },
    }).config;
    assert.equal(config.model_auto_compact_token_limit, 180_000);
    assert.equal(config.model_auto_compact_token_limit_scope, "total");
  });

  it("reports the limit in force as the compaction point", () => {
    assert.equal(CodexAdapterV2.codexCompactLimit({ compactAt: 180_000 }, "300000"), 180_000);
    assert.equal(CodexAdapterV2.codexCompactLimit({ compactAt: null }, "300000"), 300_000);
    assert.equal(CodexAdapterV2.codexCompactLimit(undefined, "300000"), 300_000);
    assert.isUndefined(CodexAdapterV2.codexCompactLimit(undefined, ""));
    const usage = (limit?: number) =>
      CodexAdapterV2.codexProviderTurnTokenUsage(
        {
          total: {
            totalTokens: 1,
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 1,
            inputTokens: 1,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 400_000,
        },
        "2026-08-29T00:00:00.000Z",
        limit,
      );
    assert.equal(usage(180_000).autoCompactThreshold, 180_000);
    assert.notProperty(usage(), "autoCompactThreshold");
  });

  it("leaves Codex's own limit alone when the setting is empty", () => {
    assert.notProperty(params(""), "model_auto_compact_token_limit");
    assert.notProperty(params(), "model_auto_compact_token_limit");
  });
});

describe("CodexAdapterV2 agent command environment", () => {
  it("puts a thread's browser-run credential in its shells beside the thread id", () => {
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-codex-browser-run"),
      threadId: ThreadId.make("thread-codex-browser-run"),
      providerSessionId: "mcp-session-codex-browser-run",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-codex-token",
      browserToolsAvailable: true,
      browserRunEnvironment: {
        T3_BROWSER_RUN_URL: "http://127.0.0.1:43123/mcp/browser-run",
        T3_BROWSER_RUN_TOKEN: "browser-run-token",
      },
    };
    const config = CodexAdapterV2.codexThreadRuntimeParams({
      threadId: mcpSession.threadId,
      mcpSession,
    }).config;
    assert.equal(
      config["shell_environment_policy.set.T3CODE_THREAD_ID"],
      "thread-codex-browser-run",
    );
    assert.equal(
      config["shell_environment_policy.set.T3_BROWSER_RUN_URL"],
      "http://127.0.0.1:43123/mcp/browser-run",
    );
    assert.equal(config["shell_environment_policy.set.T3_BROWSER_RUN_TOKEN"], "browser-run-token");

    // A session without the run lane carries nothing extra, and never the session's own bearer.
    const { browserRunEnvironment: _runs, ...sessionWithoutRuns } = mcpSession;
    const withoutRuns = CodexAdapterV2.codexThreadRuntimeParams({
      threadId: ThreadId.make("thread-codex-no-runs"),
      mcpSession: sessionWithoutRuns,
    }).config;
    assert.isUndefined(withoutRuns["shell_environment_policy.set.T3_BROWSER_RUN_TOKEN"]);
    // The session's own bearer stays in the MCP server config, never in a shell's environment.
    assert.notInclude(
      Object.keys(withoutRuns).filter((key) => key.startsWith("shell_environment_policy")),
      "secret-codex-token",
    );
  });
});

describe("Codex file-change approval paths", () => {
  const nativeThreadId = "file-approval-thread";
  const nativeTurnId = "file-approval-turn";
  const prompt = "Edit the files.";
  type FileUpdateChange = CodexSchema.V2ItemStartedNotification__FileUpdateChange;
  const addA: FileUpdateChange = { path: "/w/a.ts", kind: { type: "add" }, diff: "export {};" };
  const fileChange = (
    phase: "started" | "completed",
    turnId: string,
    itemId: string,
    changes: ReadonlyArray<FileUpdateChange>,
  ): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `${phase} ${itemId}`,
    frame: {
      method: `item/${phase}`,
      params: {
        threadId: nativeThreadId,
        turnId,
        ...(phase === "started" ? { startedAtMs: 1 } : { completedAtMs: 3 }),
        item: {
          type: "fileChange",
          id: itemId,
          status: phase === "started" ? "inProgress" : "completed",
          changes,
        },
      },
    },
  });

  const approval = (input: {
    readonly id: number;
    readonly turnId: string;
    readonly itemId: string;
  }): Array<CodexReplay.CodexAppServerReplayEntry> => [
    {
      type: "emit_inbound",
      label: `approval ${input.itemId}`,
      frame: {
        id: input.id,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: nativeThreadId,
          turnId: input.turnId,
          itemId: input.itemId,
          startedAtMs: 2,
          reason: null,
          grantRoot: null,
        },
      },
    },
    {
      type: "expect_outbound",
      label: `approval ${input.itemId}`,
      frame: { id: input.id, result: { decision: "accept" } },
    },
  ];

  const turnCompleted = (turnId: string): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `complete ${turnId}`,
    frame: {
      method: "turn/completed",
      params: {
        threadId: nativeThreadId,
        turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
      },
    },
  });

  it.effect("answers a request that reaches a full-access turn without asking", () =>
    Effect.gen(function* () {
      const asked: Array<OrchestrationV2RuntimeRequest> = [];
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: "file-approval-full-access",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            fileChange("started", nativeTurnId, "patch-a", [addA]),
            ...approval({ id: 0, turnId: nativeTurnId, itemId: "patch-a" }),
            fileChange("completed", nativeTurnId, "patch-a", [addA]),
            turnCompleted(nativeTurnId),
          ],
        }),
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
            ? Effect.sync(() => {
                asked.push(event.runtimeRequest);
              })
            : Effect.void,
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("file-approval-full-access-attempt"),
          text: prompt,
        }),
      );
      yield* harness.firstTerminal;

      assert.deepEqual(asked, []);
      assert.deepEqual(
        harness.terminalEvents().map((event) => event.status),
        ["completed"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          NodeCrypto.layer,
        ),
      ),
    ),
  );
});
