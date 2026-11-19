// Fork cases for the Pi adapter live here; upstream's own cases stay in adapter.test.ts.
import * as Redacted from "effect/Redacted";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as AgentMcpServers from "@t3tools/provider-core/server/AgentMcpServers";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { makePiAdapterV2, PiAdapterV2Driver, type PiAdapterV2Options } from "./adapter.ts";
import type { PiRpcRecord } from "./rpc.ts";
import { loadMcpBridge } from "./mcpBridge.testkit.ts";
import { PI_T3_SERVICE_TIER_COMMAND } from "./mcpExtensionSource.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const PI_INSTANCE_ID = ProviderInstanceId.make("pi");
const THREAD_ID = ThreadId.make("thread-pi-test");
const SESSION_ID = ProviderSessionId.make("provider-session-pi-test");
const FAKE_SESSION_FILE = "/fake/.pi/agent/sessions/--workspace--/0001_abc.jsonl";
/** Deliberately outside the valid pid range so a group-kill can never land. */
const FAKE_PID = 999_999_999;

const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const modelSelection = (model: string): ModelSelection => ({
  instanceId: PI_INSTANCE_ID,
  model,
});

interface FakePi {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly emit: (record: PiRpcRecord, chunkBytes?: number) => Effect.Effect<void>;
  readonly takeRequest: (type: string) => Effect.Effect<PiRpcRecord>;
  readonly queueEntries: (data: unknown) => void;
  readonly queueMessages: (data: unknown) => void;
  readonly vetoNextSwitch: () => void;
  readonly failNextFork: () => void;
  readonly queueState: (data: Record<string, unknown>) => void;
  readonly setStreaming: (streaming: boolean) => void;
  readonly setCompacting: (compacting: boolean) => void;
  readonly deferNextState: (started?: Deferred.Deferred<void>) => void;
  readonly resolveDeferredState: (data: unknown) => Effect.Effect<void>;
  readonly failNextState: (skip?: number) => void;
  readonly failNextThinking: () => void;
  readonly deferNextLifecycle: (
    type: "switch_session" | "new_session" | "fork" | "prompt" | "abort",
  ) => void;
  readonly deferNextModelSelection: () => void;
  readonly queueModels: (models: ReadonlyArray<unknown>) => void;
  readonly vetoNextNewSession: () => void;
  readonly allRequests: () => ReadonlyArray<PiRpcRecord>;
  readonly promptThinkingLevels: ReadonlyArray<string>;
  readonly promptModels: ReadonlyArray<string>;
  /** Simulates a native extension changing Pi's active selection. */
  readonly changeNatively: (change: {
    readonly model?: string;
    readonly thinking?: string;
  }) => void;
  /** T3 extension's service tier as each prompt was sent; Pi resets it with each session. */
  readonly promptServiceTiers: ReadonlyArray<string | null>;
  /** Pi reloads extensions without the adapter seeing it, e.g. a user extension's ctx.newSession(). */
  readonly reloadExtensions: (newSessionFile?: string) => void;
  /** Pi before 0.99 acknowledges prompts without a disposition. */
  readonly omitPromptDisposition: () => void;
  readonly queueStats: (data: unknown) => void;
  /** Pi before 0.84.4 answers clear_queue as an unknown command. */
  readonly setClearQueue: (
    result:
      | { readonly steering: ReadonlyArray<string>; readonly followUp: ReadonlyArray<string> }
      | "unknown_command",
  ) => void;
  readonly closeStdout: Effect.Effect<void>;
  readonly lastSpawn: () => {
    readonly args: ReadonlyArray<string>;
    readonly env: NonNullable<ChildProcess.CommandOptions["env"]>;
  };
}

const recordedIdleState = (sessionFile: string) => ({
  thinkingLevel: "high",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  sessionFile,
  sessionId: "00000000-0000-4000-8000-000000000002",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
});

const PI_COMPACTING_PROMPT_ERROR =
  "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.";

const makeFakePi: Effect.Effect<FakePi> = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const requests = yield* Queue.unbounded<PiRpcRecord>();
  const entriesQueue: Array<unknown> = [];
  const messagesQueue: Array<unknown> = [];
  const stateQueue: Array<Record<string, unknown>> = [];
  const statsQueue: Array<unknown> = [];
  const allRequests: Array<PiRpcRecord> = [];
  let deferState = false;
  let deferredStateStarted: Deferred.Deferred<void> | undefined;
  let deferredStateRequest: PiRpcRecord | undefined;
  let failStateAfter: number | null = null;
  let failThinking = false;
  let vetoSwitch = false;
  let failFork = false;
  let vetoNewSession = false;
  let deferredLifecycle: string | undefined;
  let sessionFile = FAKE_SESSION_FILE;
  let sessionGeneration = 0;
  let models: ReadonlyArray<unknown> = [];
  let isStreaming: boolean | null = null;
  let isCompacting = false;
  let clearQueue: Parameters<FakePi["setClearQueue"]>[0] = { steering: [], followUp: [] };
  let stdinBuffer = "";
  let thinkingLevel = "high";
  const promptThinkingLevels: Array<string> = [];
  const promptModels: Array<string> = [];
  const promptServiceTiers: Array<string | null> = [];
  let serviceTier: string | null = null;
  let promptDisposition = true;
  let currentModel = "default";
  const serviceTierCommand = `/${PI_T3_SERVICE_TIER_COMMAND}`;

  const emit = (record: PiRpcRecord, chunkBytes?: number) =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode(`${encodeJsonLine(record)}\n`);
      const size = chunkBytes ?? bytes.byteLength;
      for (let offset = 0; offset < bytes.byteLength; offset += size) {
        yield* Queue.offer(stdout, bytes.subarray(offset, offset + size));
      }
    });

  const respondTo = (record: PiRpcRecord): PiRpcRecord | null => {
    if (
      typeof record["id"] !== "string" &&
      !(record["type"] === "prompt" && (isStreaming !== null || isCompacting))
    )
      return null;
    const base = {
      type: "response",
      id: record["id"],
      command: String(record["type"]),
      success: true,
    };
    switch (record["type"]) {
      case "get_state":
        if (failStateAfter !== null && failStateAfter-- === 0) {
          failStateAfter = null;
          return { ...base, success: false, error: "state unavailable" };
        }
        return {
          ...base,
          data: {
            ...recordedIdleState(sessionFile),
            thinkingLevel,
            ...(currentModel === "default"
              ? {}
              : {
                  model: {
                    provider: currentModel.slice(0, currentModel.indexOf("/")),
                    id: currentModel.slice(currentModel.indexOf("/") + 1),
                  },
                }),
            isStreaming: isStreaming ?? false,
            ...stateQueue.shift(),
          },
        };
      case "set_model":
        // Pi reapplies the target model's configured thinking default.
        thinkingLevel = "low";
        currentModel = `${String(record["provider"])}/${String(record["modelId"])}`;
        return base;
      case "set_thinking_level":
        if (failThinking) {
          failThinking = false;
          return { ...base, success: false, error: "thinking unavailable" };
        }
        thinkingLevel = String(record["level"]);
        return base;
      case "prompt":
        if (String(record["message"]).startsWith(serviceTierCommand)) {
          serviceTier = String(record["message"]).slice(serviceTierCommand.length).trim() || null;
          return promptDisposition ? { ...base, data: { disposition: "handled" } } : base;
        }
        if (isCompacting) {
          return { ...base, success: false, error: PI_COMPACTING_PROMPT_ERROR };
        }
        if (isStreaming && record["streamingBehavior"] === undefined) {
          return {
            ...base,
            success: false,
            error:
              "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
          };
        }
        return promptDisposition && isStreaming
          ? { ...base, data: { disposition: "queued" } }
          : base;
      case "get_available_models":
        return { ...base, data: { models } };
      case "new_session": {
        const cancelled = vetoNewSession;
        vetoNewSession = false;
        if (!cancelled) {
          sessionFile = `/fake/new-${++sessionGeneration}.jsonl`;
          serviceTier = null;
        }
        return { ...base, data: { cancelled } };
      }
      case "switch_session": {
        const cancelled = vetoSwitch;
        vetoSwitch = false;
        if (!cancelled) serviceTier = null;
        return { ...base, data: { cancelled } };
      }
      case "get_entries":
        return { ...base, data: entriesQueue.shift() ?? { entries: [], leafId: null } };
      case "get_messages":
        return { ...base, data: messagesQueue.shift() ?? { messages: [] } };
      case "get_session_stats":
        return { ...base, data: statsQueue.shift() ?? {} };
      case "fork":
        if (failFork) {
          failFork = false;
          return { ...base, success: false, error: "Invalid entry ID for forking" };
        }
        serviceTier = null;
        return { ...base, data: { text: "Hello pi", cancelled: false } };
      case "clear_queue":
        return clearQueue === "unknown_command"
          ? { ...base, success: false, error: "Unknown command: clear_queue" }
          : { ...base, data: clearQueue };
      default:
        return base;
    }
  };

  const handleStdinChunk = (chunk: Uint8Array) =>
    Effect.gen(function* () {
      stdinBuffer += new TextDecoder().decode(chunk);
      while (true) {
        const newline = stdinBuffer.indexOf("\n");
        if (newline === -1) return;
        const line = stdinBuffer.slice(0, newline);
        stdinBuffer = stdinBuffer.slice(newline + 1);
        if (line.length === 0) continue;
        const record = decodeJsonLine(line) as PiRpcRecord;
        if (
          record["type"] === "prompt" &&
          !String(record["message"]).startsWith(serviceTierCommand)
        ) {
          promptThinkingLevels.push(thinkingLevel);
          promptModels.push(currentModel);
          promptServiceTiers.push(serviceTier);
        }
        allRequests.push(record);
        yield* Queue.offer(requests, record);
        if (record["type"] === "get_state" && deferState) {
          deferState = false;
          deferredStateRequest = record;
          if (deferredStateStarted !== undefined) {
            yield* Deferred.succeed(deferredStateStarted, undefined);
            deferredStateStarted = undefined;
          }
          continue;
        }
        if (record["type"] === deferredLifecycle) {
          deferredLifecycle = undefined;
          continue;
        }
        const response = respondTo(record);
        if (response !== null) yield* emit(response);
      }
    });

  let lastSpawn: ReturnType<FakePi["lastSpawn"]> = {
    args: [],
    env: {},
  };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (ChildProcess.isStandardCommand(command)) {
        lastSpawn = {
          args: command.args.map(String),
          env: command.options.env ?? {},
        };
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(FAKE_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach(handleStdinChunk),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  const takeRequest = (type: string): Effect.Effect<PiRpcRecord> =>
    Effect.gen(function* () {
      while (true) {
        const record = yield* Queue.take(requests);
        if (record["type"] === type) return record;
      }
    });

  return {
    spawner,
    failNextThinking: () => {
      failThinking = true;
    },
    promptThinkingLevels,
    promptModels,
    changeNatively: (change) => {
      currentModel = change.model ?? currentModel;
      thinkingLevel = change.thinking ?? thinkingLevel;
    },
    promptServiceTiers,
    reloadExtensions: (newSessionFile) => {
      serviceTier = null;
      if (newSessionFile !== undefined) sessionFile = newSessionFile;
    },
    omitPromptDisposition: () => {
      promptDisposition = false;
    },
    emit,
    takeRequest,
    queueEntries: (data) => entriesQueue.push(data),
    queueMessages: (data) => messagesQueue.push(data),
    deferNextState: (started) => {
      deferState = true;
      deferredStateStarted = started;
    },
    resolveDeferredState: (data) =>
      Effect.gen(function* () {
        const record = deferredStateRequest;
        assert.isDefined(record);
        deferredStateRequest = undefined;
        yield* emit({
          type: "response",
          id: record!["id"],
          command: "get_state",
          success: true,
          data,
        });
      }),
    failNextState: (skip = 0) => {
      failStateAfter = skip;
    },
    deferNextLifecycle: (type) => {
      deferredLifecycle = type;
    },
    deferNextModelSelection: () => {
      deferredLifecycle = "set_model";
    },
    queueModels: (value) => {
      models = value;
    },
    vetoNextNewSession: () => {
      vetoNewSession = true;
    },
    allRequests: () => allRequests,
    vetoNextSwitch: () => {
      vetoSwitch = true;
    },
    failNextFork: () => {
      failFork = true;
    },
    queueState: (data) => stateQueue.push(data),
    setStreaming: (streaming) => {
      isStreaming = streaming;
    },
    setCompacting: (compacting) => {
      isCompacting = compacting;
    },
    queueStats: (data) => statsQueue.push(data),
    setClearQueue: (result) => {
      clearQueue = result;
    },
    closeStdout: Queue.end(stdout),
    lastSpawn: () => lastSpawn,
  } satisfies FakePi;
});

const makeAdapter = Effect.fnUntraced(function* (
  fake: FakePi,
  launchArgs = "",
  forkFake?: FakePi,
  continuationRequests?: PiAdapterV2Options["continuationRequests"],
) {
  const spawner =
    forkFake === undefined
      ? fake.spawner
      : ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) && command.args.includes("--fork")
            ? forkFake.spawner.spawn(command)
            : fake.spawner.spawn(command),
        );
  if (continuationRequests !== undefined) {
    return yield* PiAdapterV2Driver.create({
      instanceId: PI_INSTANCE_ID,
      displayName: undefined,
      enabled: true,
      environment: [],
      config: {
        enabled: true,
        binaryPath: "pi",
        launchArgs,
        customModels: [],
        autoCompactWindow: "",
        memoryModel: "",
      },
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
        ...continuationRequests,
        take: Effect.never,
      }),
    );
  }
  return yield* makePiAdapterV2({
    instanceId: PI_INSTANCE_ID,
    settings: {
      enabled: true,
      binaryPath: "pi",
      launchArgs,
      customModels: [],
      autoCompactWindow: "",
      memoryModel: "",
    },
    environment: {},
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
});

const openRuntime = Effect.fnUntraced(function* (
  fake: FakePi,
  model = "default",
  threadId = THREAD_ID,
  providerSessionId = SESSION_ID,
  forkFake?: FakePi,
  continuationRequests?: PiAdapterV2Options["continuationRequests"],
  initialNativeThreadId?: string,
) {
  const adapter = yield* makeAdapter(fake, "", forkFake, continuationRequests);
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId,
    modelSelection: modelSelection(model),
    runtimePolicy,
    ...(initialNativeThreadId === undefined ? {} : { initialNativeThreadId }),
  });
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const takeEvent = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(emitted);
        if (predicate(event)) return event;
      }
    });
  return { runtime, takeEvent };
});

const makeAppThread = Effect.fnUntraced(function* (model: string, threadId = THREAD_ID) {
  const now = yield* DateTime.now;
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: "project:fixture:pi" as OrchestrationV2AppThread["projectId"],
    title: "Pi test thread",
    providerInstanceId: PI_INSTANCE_ID,
    modelSelection: modelSelection(model),
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
  } satisfies OrchestrationV2AppThread;
});

const readSpawnEnv = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  model = "default",
  attachments: ReadonlyArray<ChatAttachment> = [],
  text = "Hello pi",
  selection?: ModelSelection,
  runOrdinal = 1,
  threadId = THREAD_ID,
  continuation = false,
  videoFrames?: ProviderAdapter.ProviderAdapterV2TurnMessage["videoFrames"],
) {
  const appThread = yield* makeAppThread(model, threadId);
  const runId = RunId.make(`run:${threadId}:${runOrdinal}`);
  yield* runtime.startTurn({
    appThread,
    threadId,
    runId,
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${threadId}:${runOrdinal}` as never,
      text,
      attachments,
      videoFrames,
      createdBy: continuation ? "agent" : "user",
      creationSource: continuation ? "provider" : "web",
    },
    modelSelection: selection ?? modelSelection(model),
    runtimePolicy,
  });
});

describe("PiAdapterV2", () => {
  it.effect("sends labeled video images and skips vanished frames", () =>
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

      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Watch",
        undefined,
        1,
        THREAD_ID,
        false,
        videoFrames,
      );
      const request = yield* fake.takeRequest("prompt");
      assert.include(request.message as string, '[Frame of video "clip.mp4" at 00:03.200]');
      assert.include(request.message as string, '[Frame of video "clip.mp4" at 00:07.200]');
      assert.notInclude(request.message as string, framePath);
      assert.deepEqual(request.images, [
        { type: "image", data: "CQo=", mimeType: "image/jpeg" },
        { type: "image", data: "CQo=", mimeType: "image/jpeg" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect(
    "sandboxes reader shells and withholds edit and write tools from managed read-only sessions",
    () =>
      Effect.gen(function* () {
        const launches: Array<ReadonlyArray<string>> = [];
        const open = (policy: Partial<ProviderAdapter.ProviderAdapterV2RuntimePolicy>) =>
          Effect.gen(function* () {
            const fake = yield* makeFakePi;
            const adapter = yield* makePiAdapterV2({
              instanceId: PI_INSTANCE_ID,
              settings: {
                enabled: true,
                binaryPath: "pi",
                launchArgs: "--tools read,bash --extension /user/extension.ts -e /user/other.ts",
                customModels: [],
                autoCompactWindow: "",
                memoryModel: "",
              },
              environment: {},
            }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
            yield* adapter.openSession({
              threadId: THREAD_ID,
              providerSessionId: SESSION_ID,
              modelSelection: modelSelection("default"),
              runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: null,
                ...policy,
              }),
            });
          }).pipe(
            Effect.scoped,
            Effect.provideService(AgentScope, {
              ...AgentScope.defaultValue(),
              wrap: ({ command, args }) =>
                Effect.sync(() => {
                  launches.push(args);
                  return { command, args, unit: "t3code-pi-test.scope" };
                }),
              stop: () => Effect.void,
            }),
          );
        yield* open({
          managedAgent: true,
          readOnlyShell: true,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        });
        yield* open({
          managedAgent: true,
          approvalPolicy: "never",
          sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
        });
        yield* open({});
        const [readOnly, writer, ordinary] = launches;
        if (readOnly === undefined || writer === undefined || ordinary === undefined) {
          assert.fail("Expected read-only, writer and ordinary Pi launches");
        }
        // A user's tool selection cannot re-enable the withheld tools, while provider extensions still load.
        assert.notInclude(readOnly, "read,bash");
        assert.include(readOnly, "--no-mcp");
        assert.deepEqual(
          readOnly.slice(readOnly.indexOf("--tools"), readOnly.indexOf("--tools") + 2),
          ["--tools", "read,grep,find,ls,tool_search,codemode,bash"],
        );
        assert.deepEqual(
          readOnly.slice(
            readOnly.indexOf("--exclude-tools"),
            readOnly.indexOf("--exclude-tools") + 2,
          ),
          [
            "--exclude-tools",
            "edit,write,powershell,list_mcp_resources,list_mcp_resource_templates,read_mcp_resource,mcp__*",
          ],
        );
        assert.notInclude(readOnly, "--no-extensions");
        assert.include(readOnly, "/user/extension.ts");
        assert.include(readOnly, "/user/other.ts");
        const extensions = readOnly.flatMap((arg, index) =>
          arg === "--extension" || arg === "-e" ? [readOnly[index + 1]] : [],
        );
        assert.lengthOf(extensions, 3);
        assert.isTrue(extensions.at(-1)?.endsWith("pi-t3-mcp-extension.ts"));
        for (const args of [writer, ordinary]) {
          assert.notInclude(args, "--no-extensions");
          assert.include(args, "/user/extension.ts");
          assert.include(args, "/user/other.ts");
          assert.notInclude(args, "--exclude-tools");
          assert.include(args, "read,bash");
        }
      }).pipe(Effect.provide(layerTest)),
  );
  it.effect("delivers the managed browser catalogue and guidance beside Weave", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set({
        environmentId: EnvironmentId.make("environment-pi-browser"),
        threadId: THREAD_ID,
        providerSessionId: "mcp-session-pi-browser",
        providerInstanceId: PI_INSTANCE_ID,
        endpoint: "http://fixture.invalid/mcp/browser",
        authorizationHeader: "Bearer fixture-browser-token",
        browserToolsAvailable: true,
        managedBrowser: true,
        delegated: true,
        listsPreview: true,
        listsHtml: false,
      });
      const weave = {
        name: "weave",
        url: "http://weave.invalid/mcp/weave",
        authorizationHeader: "Bearer fixture-weave-token",
        tools: ["weave_forge_read"],
      };
      const fake = yield* makeFakePi;
      const adapter = yield* makeAdapter(fake).pipe(
        Effect.provideService(AgentMcpServers.AgentMcpServers, {
          read: () => Effect.succeed([weave]),
        }),
      );
      yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...runtimePolicy,
          managedAgent: true,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        }),
      });
      const environment = Object.fromEntries(
        Object.entries(fake.lastSpawn().env).map(([name, value]) => [
          name,
          value === undefined ? undefined : readSpawnEnv(value),
        ]),
      );
      const bridge = yield* Effect.promise(() =>
        loadMcpBridge({ modern: true, environment, agentServers: [weave] }),
      );
      const ctx = { ui: { notify: assert.fail } };
      yield* Effect.promise(() => bridge.handlers.get("session_start")!({ systemPrompt: "" }, ctx));
      assert.isDefined(bridge.tools.find((tool) => tool.name === "mcp__t3-code__preview_snapshot"));
      assert.isDefined(bridge.tools.find((tool) => tool.name === "mcp__weave__weave_forge_read"));
      assert.isTrue(bridge.transports.some((transport) => transport.url.endsWith("/mcp/browser")));
      const sections: Record<string, string> = {};
      yield* Effect.promise(async () => {
        await bridge.handlers.get("before_agent_start")!(
          { systemPrompt: "", systemPromptOptions: { sections } },
          ctx,
        );
      });
      assert.include(sections.t3_code_orchestration ?? "", "preview_open");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
