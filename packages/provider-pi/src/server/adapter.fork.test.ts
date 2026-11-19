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
import * as Fiber from "effect/Fiber";
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

  const UPSTREAM_OVERLOADED =
    '429: {"type":"server_error","message":"Upstream request failed: [overloaded] the server is overloaded; retry shortly"}';

  it.effect("coalesces rotating braille spinner frames in blackhole extension status", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      for (const frame of ["⠋", "⠙", "⠹", "⠸"]) {
        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "blackhole",
          statusText: `bh O▕████░░░░▏  P▕░░░░░░░░▏  X▕█░░░░░░░▏  ${frame} [observer]`,
        });
      }
      yield* fake.emit({
        type: "extension_ui_request",
        id: "spinner-barrier",
        method: "input",
        title: "Continue?",
      });
      const observed: ProviderAdapter.ProviderAdapterV2Event[] = [];
      yield* takeEvent((event) => {
        observed.push(event);
        return event.type === "runtime_request.updated";
      });
      const snapshots = observed.filter((event) => event.type === "provider_session.updated");
      assert.lengthOf(snapshots, 1);
      assert.deepInclude(runtime.providerSession, {
        extensionStatuses: [
          {
            key: "blackhole",
            text: "bh O▕████░░░░▏  P▕░░░░░░░░▏  X▕█░░░░░░░▏  • [observer]",
          },
        ],
      });
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("replaces Pi's agent scope when the process restarts for a compaction point", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const fileSystem = yield* FileSystem.FileSystem;
      const agentDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-compaction-" });
      yield* fileSystem.writeFileString(`${agentDir}/settings.json`, "{}\n");
      // The session and its compaction check each read the model, so both get_state replies
      // carry one.
      fake.queueState({ model: { provider: "anthropic", id: "claude-x", contextWindow: 200_000 } });
      fake.queueState({ model: { provider: "anthropic", id: "claude-x", contextWindow: 200_000 } });
      const stopped: Array<string> = [];
      let spawns = 0;
      let wraps = 0;
      yield* Effect.gen(function* () {
        const adapter = yield* makePiAdapterV2({
          instanceId: PI_INSTANCE_ID,
          settings: {
            enabled: true,
            binaryPath: "pi",
            launchArgs: "",
            customModels: [],
            autoCompactWindow: "",
            memoryModel: "",
          },
          environment: { PI_CODING_AGENT_DIR: agentDir },
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              Effect.sync(() => {
                spawns += 1;
              }).pipe(Effect.andThen(fake.spawner.spawn(command))),
            ),
          ),
        );
        yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: null,
            modelCompactAt: 120_000,
          }),
        });
        assert.deepEqual(stopped, ["t3code-pi-test-1.scope"]);
        assert.equal(wraps, 2);
        assert.equal(spawns, 2);
      }).pipe(
        Effect.scoped,
        Effect.provideService(AgentScope, {
          ...AgentScope.defaultValue(),
          wrap: ({ command, args }) =>
            Effect.sync(() => {
              if (wraps > 0) assert.deepEqual(stopped, ["t3code-pi-test-1.scope"]);
              wraps += 1;
              return { command, args, unit: `t3code-pi-test-${wraps}.scope` };
            }),
          stop: (unit) => Effect.sync(() => void stopped.push(unit)),
        }),
      );
      assert.deepEqual(stopped, ["t3code-pi-test-1.scope", "t3code-pi-test-2.scope"]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("hands the thread's agent servers to the bridge", () =>
    Effect.gen(function* () {
      const weave = {
        name: "weave",
        url: "http://127.0.0.1:43123/mcp/weave",
        authorizationHeader: "Bearer thread-weave-credential",
      };
      const fake = yield* makeFakePi;
      yield* openRuntime(fake).pipe(
        Effect.provideService(
          AgentMcpServers.AgentMcpServers,
          AgentMcpServers.AgentMcpServers.of({
            read: (threadId) => Effect.succeed(threadId === THREAD_ID ? [weave] : []),
          }),
        ),
      );
      assert.deepEqual(JSON.parse(readSpawnEnv(fake.lastSpawn().env.T3_MCP_AGENT_SERVERS!)), [
        weave,
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([
    { name: "a one-hour write", usage: { cacheWrite: 50, cacheWrite1h: 50 }, ttlMs: 3_600_000 },
    { name: "a five-minute write", usage: { cacheWrite: 50, cacheWrite1h: 0 }, ttlMs: 300_000 },
    { name: "a fully cached request", usage: { cacheWrite: 0, cacheWrite1h: 0 } },
    { name: "a cache without lifetimes", usage: { cacheWrite: 50 } },
  ])("dates the prompt cache expiry from the request after $name", ({ usage, ttlMs }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const requestedAt = Date.parse("2026-11-16T10:00:00.000Z");
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          provider: "anthropic",
          model: "claude-sonnet-5",
          usage: { input: 2, output: 10, cacheRead: 100_000, ...usage },
          stopReason: "stop",
          timestamp: requestedAt,
        },
      });
      fake.queueStats({ contextUsage: { tokens: 100_162, contextWindow: 200_000 } });
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
      yield* fake.emit({ type: "agent_settled" });
      const completed = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert(completed.type === "provider_turn.updated");
      const tokenUsage = completed.providerTurn.tokenUsage;
      assert.deepEqual(
        {
          ttlMs: tokenUsage?.promptCacheTtlMs,
          expiresAt: tokenUsage?.promptCacheExpiresAt,
        },
        ttlMs === undefined
          ? { ttlMs: undefined, expiresAt: undefined }
          : { ttlMs, expiresAt: DateTime.formatIso(DateTime.makeUnsafe(requestedAt + ttlMs)) },
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("codes an upstream overload at retry start and on the final failure", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");

      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: true });
      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 1_000,
        errorMessage: UPSTREAM_OVERLOADED,
      });
      const retry = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      assert.isTrue(
        retry.type === "turn_item.updated" &&
          retry.turnItem.type === "error" &&
          retry.turnItem.failure.class === "provider_error" &&
          retry.turnItem.failure.code === "overloaded",
      );

      yield* fake.emit({
        type: "auto_retry_end",
        success: false,
        attempt: 2,
        finalError: UPSTREAM_OVERLOADED,
      });
      const failed = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.status === "failed",
      );
      assert.isTrue(
        failed.type === "turn_item.updated" &&
          failed.turnItem.type === "error" &&
          failed.turnItem.failure.code === "overloaded",
      );
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.code === "overloaded",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([
    { errorMessage: UPSTREAM_OVERLOADED, code: "overloaded" },
    {
      errorMessage:
        '429: {"type":"server_error","message":"The inference service is overloaded. Please try again later."}',
      code: "overloaded",
    },
    { errorMessage: "429 Too Many Requests: rate limited", code: null },
    {
      errorMessage: '429: {"type":"GoUsageLimitError","message":"OpenCode Go usage limit reached"}',
      code: null,
    },
    { errorMessage: "temporary network failure", code: null },
  ])(
    "codes a model error as an overload only when the upstream said so",
    ({ errorMessage, code }) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({
          type: "message_end",
          message: { role: "assistant", content: [], stopReason: "error", errorMessage },
        });
        yield* fake.emit({ type: "agent_settled" });
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "failed");
        assert.equal(terminal.type === "turn.terminal" ? terminal.failure?.code : undefined, code);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("codes a quota the upstream says to wait out as a usage limit to its reset", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const reportedAt = yield* DateTime.now;
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage:
            "Quota reached. Please wait 113h50m33s. (Enable AI credits fallback with /antigravity.credits on) Next: switch models or try again after reset.",
        },
      });
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.class === "usage_limit" &&
          terminal.failure.resetAt ===
            DateTime.formatIso(
              DateTime.addDuration(reportedAt, {
                hours: 113,
                minutes: 50,
                seconds: 33,
              }),
            ),
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("records a compaction Pi runs after the turn ended on that run and its context", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "Quota reached" },
      });
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "failed");

      yield* fake.emit({ type: "compaction_start", reason: "threshold" });
      const started = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      yield* fake.emit({
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "smaller", tokensBefore: 426_013, estimatedTokensAfter: 3_400 },
        aborted: false,
        willRetry: false,
      });
      const completed = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status !== "running",
      );
      const usage = yield* takeEvent((event) => event.type === "provider_thread.updated");

      assert.isTrue(
        started.type === "turn_item.updated" &&
          started.sessionScoped === true &&
          started.turnItem.status === "running" &&
          started.turnItem.providerTurnId === providerTurnId &&
          started.turnItem.nodeId === null,
      );
      assert.isTrue(
        completed.type === "turn_item.updated" &&
          started.type === "turn_item.updated" &&
          completed.sessionScoped === true &&
          completed.turnItem.id === started.turnItem.id &&
          completed.turnItem.runId === started.turnItem.runId &&
          completed.turnItem.type === "compaction" &&
          completed.turnItem.status === "completed" &&
          completed.turnItem.beforeTokenCount === 426_013 &&
          completed.turnItem.afterTokenCount === 3_400,
      );
      assert.isTrue(
        usage.type === "provider_thread.updated" &&
          usage.sessionScoped === true &&
          usage.providerThread.contextUsage?.usedTokens === 3_400 &&
          usage.providerThread.contextUsage.updatedAt !== undefined,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps a compaction's context when it ends while the next turn sets up", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent((event) => event.type === "turn.terminal");

      fake.deferNextModelSelection();
      const starting = yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Second turn",
        modelSelection("xai/grok-4.6"),
        2,
      ).pipe(Effect.forkScoped);
      const modelRequest = yield* fake.takeRequest("set_model");
      yield* fake.emit({ type: "compaction_start", reason: "threshold" });
      yield* fake.emit({
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "smaller", tokensBefore: 426_013, estimatedTokensAfter: 3_400 },
        aborted: false,
        willRetry: false,
      });
      yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.contextUsage?.usedTokens === 3_400,
      );
      yield* fake.emit({
        type: "response",
        id: modelRequest["id"],
        command: "set_model",
        success: true,
        data: { provider: "xai", id: "grok-4.6" },
      });
      yield* Fiber.join(starting);
      const active = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" && event.providerThread.status === "active",
      );
      assert.isTrue(
        active.type === "provider_thread.updated" &&
          active.providerThread.contextUsage?.usedTokens === 3_400,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([
    {
      name: "the Utility model when it is a Pi model",
      utility: { driver: "pi", model: "opencode-go/deepseek-v4.1-flash", thinking: "high" },
      expected: { provider: "opencode-go", id: "deepseek-v4.1-flash", thinking: "high" },
      spawns: 2,
    },
    {
      name: "the Memory worker setting when the Utility model is not Pi's",
      utility: { driver: "codex", model: "gpt-6-luna" },
      expected: { provider: "anthropic", id: "claude-haiku-5", thinking: "low" },
      spawns: 2,
    },
    {
      name: "a model it already has, without restarting Pi",
      utility: { driver: "pi", model: "openai-codex/gpt-6-luna" },
      expected: { provider: "openai-codex", id: "gpt-6-luna", thinking: "low" },
      spawns: 1,
    },
  ])("gives Pi Blackhole's memory worker $name", ({ utility, expected, spawns: expectedSpawns }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const fileSystem = yield* FileSystem.FileSystem;
      const agentDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-blackhole-" });
      const configPath = `${agentDir}/pi-blackhole/pi-blackhole-config.json`;
      yield* fileSystem.makeDirectory(`${agentDir}/pi-blackhole`);
      yield* fileSystem.writeFileString(
        configPath,
        JSON.stringify({ model: { provider: "openai-codex", id: "gpt-6-luna", thinking: "low" } }),
      );
      let spawns = 0;
      const adapter = yield* makePiAdapterV2({
        instanceId: PI_INSTANCE_ID,
        settings: {
          enabled: true,
          binaryPath: "pi",
          launchArgs: "",
          customModels: [],
          autoCompactWindow: "",
          memoryModel: "anthropic/claude-haiku-5",
        },
        environment: { PI_CODING_AGENT_DIR: agentDir },
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.sync(() => {
              spawns += 1;
            }).pipe(Effect.andThen(fake.spawner.spawn(command))),
          ),
        ),
      );
      yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
          utilityModel: utility,
        }),
      });
      const written = JSON.parse(yield* fileSystem.readFileString(configPath));
      assert.deepEqual(written.model, expected);
      assert.equal(spawns, expectedSpawns);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["canonical", "legacy"] as const)(
    "launches Pi with the restored %s registration choice",
    (registration) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const servers = ["weave", ...(registration === "legacy" ? ["yardsmith-hq"] : [])].map(
          (name) => ({
            name,
            url: "http://weave.invalid/mcp/weave",
            authorizationHeader: "Bearer fixture",
          }),
        );
        yield* openRuntime(fake).pipe(
          Effect.provideService(AgentMcpServers.CurrentRegistration, registration),
          Effect.provideService(
            AgentMcpServers.AgentMcpServers,
            AgentMcpServers.AgentMcpServers.of({
              read: (_threadId, choice) => {
                assert.equal(choice, registration);
                return Effect.succeed(servers);
              },
            }),
          ),
        );
        assert.deepEqual(
          JSON.parse(readSpawnEnv(fake.lastSpawn().env.T3_MCP_AGENT_SERVERS!)),
          servers,
        );
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
