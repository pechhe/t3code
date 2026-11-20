import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type ProviderReplayEntry,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as AgentMcpServers from "@t3tools/provider-core/server/AgentMcpServers";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { OPENCODE_PROVIDER } from "@t3tools/provider-opencode/testing";
import { openCode2ReplayRuntime } from "./OpenCode2AdapterV2.testkit.ts";

const SESSION = "ses_f148ca2deffeJcwCnRQtb0YFNX";
const WORK = "/work/opencode2";
const instanceId = ProviderInstanceId.make("opencode");
const threadId = ThreadId.make("thread:opencode2-adapter");

const out = (type: string, input?: unknown): ProviderReplayEntry => ({
  type: "expect_outbound",
  frame: input === undefined ? { type } : { type, input },
});
const reply = (operation: string, data: unknown): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: { type: "sdk.response", operation, data },
});
const replyData = (operation: string, data: unknown) => reply(operation, { data });
const event = (
  type: string,
  data: Record<string, unknown>,
  label?: string,
  version = 1,
): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: {
    type: "sdk.event",
    event: {
      id: `evt_${type.replaceAll(".", "")}0000`,
      created: 1,
      type,
      ...(type.startsWith("rpc.") ? { location: { directory: WORK } } : {}),
      data,
      durable: { ...durable.durable, version },
    },
  },
  ...(label === undefined ? {} : { label }),
});
const durable = { durable: { aggregateID: SESSION, seq: 1, version: 1 } };

const mcpRules = [
  { action: "t3-code-*", resource: "*", effect: "deny" },
  { action: "t3-code-thread_opencode2-adapter_*", resource: "*", effect: "allow" },
];
const t3Rules = [{ action: "*", resource: "*", effect: "allow" }, ...mcpRules];
const TITLE = "Prime check";
const sessionInfo = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION,
  title: TITLE,
  permissions: t3Rules,
  projectID: "global",
  model: { id: "big-pickle", providerID: "opencode", variant: "default" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1790656601394, updated: 1790656601394 },
  location: { directory: WORK },
  ...overrides,
});
const modelCatalog = {
  location: { directory: WORK },
  data: [
    {
      id: "big-pickle",
      modelID: "big-pickle",
      providerID: "opencode",
      family: "big-pickle",
      name: "Big Pickle",
      compatibility: { reasoningField: "reasoning_content" },
      package: "@opencode/ai/providers/openai-compatible",
      settings: { apiKey: "public", baseURL: "https://opencode.ai/zen/v1", provider: "opencode" },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [],
      time: { released: 1760659200000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      status: "active",
      enabled: true,
      limit: { context: 200000, input: 160000, output: 32000 },
    },
  ],
};

const PROMPT_ID = "msg_0eb735d41001NJee1EvVePJAK5";
const promptAccepted = replyData("session.prompt", {
  id: PROMPT_ID,
  sessionID: SESSION,
  time: { created: 1790656601410 },
  type: "user",
  payload: { text: "hi" },
  delivery: "steer",
});

const noOpenRequests: ReadonlyArray<ProviderReplayEntry> = [
  out("permission.list", { sessionID: SESSION }),
  replyData("permission.list", []),
  out("session.form.list", { sessionID: SESSION }),
  replyData("session.form.list", []),
];

const opening: ReadonlyArray<ProviderReplayEntry> = [
  out("event.subscribe"),
  out("model.list", "<any>"),
  reply("model.list", modelCatalog),
];
const bigPickle: ModelSelection = { instanceId, model: "opencode/big-pickle" };
const policy = (runtimeMode: "full-access" | "approval-required" = "full-access") => ({
  runtimeMode,
  interactionMode: "default" as const,
  cwd: WORK,
});

const providerThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make("provider-thread:opencode2-adapter"),
  driver: OPENCODE_PROVIDER,
  providerInstanceId: instanceId,
  providerSessionId: ProviderSessionId.make("provider-session:opencode2-adapter"),
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver: OPENCODE_PROVIDER, nativeId: SESSION, strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
});

const turnInput = (
  thread: OrchestrationV2ProviderThread,
  modelSelection: ModelSelection = bigPickle,
  runtimeMode: "full-access" | "approval-required" = "full-access",
) => ({
  appThread: { title: TITLE } as OrchestrationV2AppThread,
  threadId,
  runId: RunId.make("run:opencode2-adapter"),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: RunAttemptId.make("attempt:opencode2-adapter"),
  rootNodeId: NodeId.make("node:opencode2-adapter"),
  providerThread: thread,
  message: {
    messageId: MessageId.make("message:opencode2-adapter"),
    text: "hi",
    attachments: [],
    createdBy: "user" as const,
    creationSource: "web" as const,
    scheduledTaskId: undefined,
    senderThreadId: undefined,
  },
  modelSelection,
  runtimePolicy: policy(runtimeMode),
});

const terminalOf = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
  runtime.events.pipe(
    Stream.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
        event.type === "turn.terminal",
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

it.layer(McpProviderSessions.layer)("OpenCode2 adapter", (it) => {
  it.effect("registers the thread's agent servers beside T3's own and keeps them to it", () =>
    Effect.gen(function* () {
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* mcpSessions.set({
        environmentId: EnvironmentId.make("environment:opencode2-adapter"),
        threadId,
        providerSessionId: "mcp:opencode2-adapter",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer thread-credential",
        browserToolsAvailable: false,
      });
      yield* Effect.addFinalizer(() => mcpSessions.clear(threadId));
      const t3 = "t3-code-thread_opencode2-adapter";
      const weave = `${t3}-weave`;
      const runtime = yield* openCode2ReplayRuntime([
        ...opening,
        out("session.get", { sessionID: SESSION }),
        replyData(
          "session.get",
          sessionInfo({
            permissions: [
              { action: "*", resource: "*", effect: "allow" },
              { action: "t3-code-*", resource: "*", effect: "deny" },
              { action: `${t3}_*`, resource: "*", effect: "allow" },
              { action: `${weave}_*`, resource: "*", effect: "allow" },
            ],
          }),
        ),
        ...noOpenRequests,
        out("mcp.add", {
          server: t3,
          "location[directory]": WORK,
          config: {
            type: "remote",
            url: "http://127.0.0.1:3773/mcp",
            headers: { Authorization: "Bearer thread-credential" },
            oauth: false,
          },
        }),
        reply("mcp.add", null),
        out("mcp.add", {
          server: weave,
          "location[directory]": WORK,
          config: {
            type: "remote",
            url: "http://127.0.0.1:3773/mcp/weave",
            headers: { Authorization: "Bearer thread-weave-credential" },
            oauth: false,
          },
        }),
        reply("mcp.add", null),
        out("session.instructions.entry.put", {
          sessionID: SESSION,
          key: "t3-code",
          value: "<any>",
        }),
        reply("session.instructions.entry.put", null),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("mcp.remove", { server: t3, "location[directory]": WORK }),
        reply("mcp.remove", null),
        out("mcp.remove", { server: weave, "location[directory]": WORK }),
        reply("mcp.remove", null),
      ]).pipe(
        Effect.provideService(
          AgentMcpServers.AgentMcpServers,
          AgentMcpServers.AgentMcpServers.of({
            read: (id) =>
              Effect.succeed(
                id === threadId
                  ? [
                      {
                        name: "weave",
                        url: "http://127.0.0.1:3773/mcp/weave",
                        authorizationHeader: "Bearer thread-weave-credential",
                      },
                    ]
                  : [],
              ),
          }),
        ),
      );
      const thread = yield* runtime.resumeThread({
        providerThread: providerThread(yield* DateTime.now),
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      const started = yield* runtime.startTurn(turnInput(thread)).pipe(Effect.forkScoped);
      yield* TestClock.adjust("250 millis");
      yield* Fiber.join(started);
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
      yield* runtime.unloadThread!({ providerThread: thread });
    }).pipe(Effect.scoped),
  );

  /**
   * OpenCode numbers the request it retries with, so its first retry is
   * attempt 2, and stamps `at` from the clock behind the event's `created` (1 here).
   */
});
