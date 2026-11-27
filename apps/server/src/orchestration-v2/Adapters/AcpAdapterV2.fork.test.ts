// Fork cases for AcpAdapterV2 live here; upstream's own cases stay in AcpAdapterV2.test.ts.
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DocumentText from "../../provider/DocumentText.ts";
import {
  ChatAttachmentId,
  ChatImageAttachment,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, beforeAll, describe, it } from "@effect/vitest";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

const layerHost = TestProviderHost.layer().pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
);

// Node spends ~0.5s loading the agent scripts' TypeScript module graph on every spawn;
// a bundle built once per file starts in ~0.15s. Tests still talk to a real subprocess.
const bundledAgents = Deferred.makeUnsafe<{
  readonly mock: string;
  readonly replay: string;
  readonly compileCache: string;
}>();
const bundleAgents = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-agents-" });
  const input = {
    mock: yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url)),
    replay: yield* path.fromFileUrl(
      new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
    ),
  };
  const { build } = yield* Effect.promise(() => import("vite-plus"));
  yield* Effect.promise(() =>
    build({
      configFile: false,
      logLevel: "silent",
      root: path.dirname(input.mock),
      ssr: { noExternal: true },
      build: {
        ssr: true,
        outDir,
        rollupOptions: { input, output: { format: "es", entryFileNames: "[name].mjs" } },
      },
    }),
  );
  yield* Deferred.succeed(bundledAgents, {
    mock: path.join(outDir, "mock.mjs"),
    replay: path.join(outDir, "replay.mjs"),
    compileCache: path.join(outDir, "compile-cache"),
  });
}).pipe(Effect.provide(NodeServices.layer));

const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function makeMockRuntime(input: {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly mockAgentPath: string;
  readonly environment?:
    | Readonly<Record<string, string>>
    | ((runtimeOrdinal: number) => Readonly<Record<string, string>>);
  readonly protocolEvents?: Queue.Queue<EffectAcpProtocol.AcpProtocolLogEvent>;
  readonly cancelBehavior?: AcpSessionRuntime.AcpSessionRuntimeOptions["cancelBehavior"];
  readonly ownDescendantProcessGroups?: boolean;
  readonly ownDetachedProcessGroup?: boolean;
  readonly processGroupPlatform?: NodeJS.Platform;
  readonly processGroupTerminationGrace?: Duration.Input;
  readonly linuxCgroupController?: AcpSessionRuntime.AcpSessionRuntimeOptions["linuxCgroupController"];
  readonly posixProcessTreeController?: AcpSessionRuntime.AcpSessionRuntimeOptions["posixProcessTreeController"];
  readonly windowsProcessTreeTerminator?: AcpSessionRuntime.AcpSessionRuntimeOptions["windowsProcessTreeTerminator"];
  readonly wrapCancel?: (
    cancel: AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"],
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"];
  readonly wrapOutgoingResponse?: (
    onOutgoingResponse: NonNullable<AcpAdapterV2RuntimeInput["onOutgoingResponse"]>,
  ) => NonNullable<AcpAdapterV2RuntimeInput["onOutgoingResponse"]>;
  readonly wrapRuntime?: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    runtimeOrdinal: number,
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"];
}): AcpAdapterV2Flavor["makeRuntime"] {
  let runtimeOrdinal = 0;
  return (runtimeInput) =>
    Effect.gen(function* () {
      runtimeOrdinal += 1;
      const protocolEvents = input.protocolEvents;
      const protocolLogging =
        protocolEvents === undefined
          ? runtimeInput.protocolLogging
          : {
              ...runtimeInput.protocolLogging,
              logIncoming: true,
              logOutgoing: true,
              logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
                Queue.offer(protocolEvents, event).pipe(
                  Effect.andThen(runtimeInput.protocolLogging.logger?.(event) ?? Effect.void),
                  Effect.asVoid,
                ),
            };
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...runtimeInput,
          ...(input.cancelBehavior === undefined ? {} : { cancelBehavior: input.cancelBehavior }),
          ...(input.ownDetachedProcessGroup === undefined
            ? {}
            : { ownDetachedProcessGroup: input.ownDetachedProcessGroup }),
          ...(input.ownDescendantProcessGroups === undefined
            ? {}
            : { ownDescendantProcessGroups: input.ownDescendantProcessGroups }),
          ...(input.ownDetachedProcessGroup === true
            ? { processGroupPlatform: input.processGroupPlatform ?? "linux" }
            : {}),
          ...(input.processGroupTerminationGrace === undefined
            ? {}
            : { processGroupTerminationGrace: input.processGroupTerminationGrace }),
          ...(input.linuxCgroupController === undefined
            ? {}
            : { linuxCgroupController: input.linuxCgroupController }),
          ...(input.posixProcessTreeController === undefined
            ? {}
            : { posixProcessTreeController: input.posixProcessTreeController }),
          ...(input.windowsProcessTreeTerminator === undefined
            ? {}
            : { windowsProcessTreeTerminator: input.windowsProcessTreeTerminator }),
          protocolLogging,
          spawn: {
            command: process.execPath,
            args: [input.mockAgentPath],
            cwd: runtimeInput.cwd,
            env: {
              T3_ACP_SESSION_LIFECYCLE: "1",
              NODE_COMPILE_CACHE: (yield* Deferred.await(bundledAgents)).compileCache,
              ...(typeof input.environment === "function"
                ? input.environment(runtimeOrdinal)
                : input.environment),
            },
          },
          authMethodId: "test",
          ...(input.wrapOutgoingResponse === undefined ||
          runtimeInput.onOutgoingResponse === undefined
            ? {}
            : {
                onOutgoingResponse: input.wrapOutgoingResponse(runtimeInput.onOutgoingResponse),
              }),
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
      const wrapped = {
        ...runtime,
        ...(input.wrapCancel === undefined ? {} : { cancel: input.wrapCancel(runtime.cancel) }),
      };
      return input.wrapRuntime?.(wrapped, runtimeOrdinal) ?? wrapped;
    });
}

function rawProtocolMethod(event: EffectAcpProtocol.AcpProtocolLogEvent): string | undefined {
  if (event.stage !== "raw" || typeof event.payload !== "string") return undefined;
  for (const line of event.payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const decoded = Option.getOrUndefined(decodeUnknownJson(trimmed));
    if (typeof decoded === "object" && decoded !== null && "method" in decoded) {
      const method = (decoded as { readonly method?: unknown }).method;
      if (typeof method === "string") return method;
    }
  }
  return undefined;
}

function rawProtocolRequest(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
): { readonly method?: unknown; readonly params?: unknown } | undefined {
  if (event.stage !== "raw" || typeof event.payload !== "string") return undefined;
  for (const line of event.payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const decoded = Option.getOrUndefined(decodeUnknownJson(trimmed));
    if (typeof decoded === "object" && decoded !== null && "method" in decoded) {
      return decoded;
    }
  }
  return undefined;
}

function rawProtocolRequestParam(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
  key: string,
): unknown {
  const params = rawProtocolRequest(event)?.params;
  return typeof params === "object" && params !== null ? Reflect.get(params, key) : undefined;
}

describe("AcpAdapterV2", () => {
  beforeAll(() => bundleAgents);

  it.live.each(["acp-test", "grok", "acpRegistry", "antigravity", "path-only"] as const)(
    "delivers labeled video frames through %s",
    (driver) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const videoDir = yield* fileSystem.makeTempDirectoryScoped();
        const framePath = videoDir + "/frame.jpg";
        yield* fileSystem.writeFile(framePath, Uint8Array.from([9, 10]));
        const timestamps =
          driver === "antigravity" ? [3200, 4000, 5000, 7200, 9000] : [3200, 7200, 9000];
        const videoFrames = timestamps.map((timestampMs, index) => ({
          videoAttachmentId: "video" as never,
          videoName: "clip.mp4",
          timestampMs,
          path: index === timestamps.length - 1 ? videoDir + "/missing.jpg" : framePath,
          mimeType: "image/jpeg" as const,
          sizeBytes: 2,
        }));
        const path = yield* Path.Path;
        const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
        const instanceId = ProviderInstanceId.make("video-" + driver);
        const threadId = ThreadId.make("video-" + driver);
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          flavor: {
            driver: ProviderDriverKind.make(driver),
            capabilities: AcpProviderCapabilitiesV2,
            supportsImagePrompts: driver !== "path-only",
            nativeAttachmentByteLimit: driver === "antigravity" ? 6 : 4,
            makeRuntime: makeMockRuntime({
              childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
              mockAgentPath: yield* path.fromFileUrl(
                new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
              ),
              protocolEvents,
            }),
          },
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" };
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("video-session-" + driver),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const input = makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        });
        const attachments =
          driver === "antigravity"
            ? [
                ChatImageAttachment.make({
                  id: ChatAttachmentId.make("user-image"),
                  type: "image",
                  name: "user.jpg",
                  mimeType: "image/jpeg",
                  sizeBytes: 2,
                }),
              ]
            : [];
        for (const attachment of attachments) {
          const host = yield* ProviderHost.ProviderHost;
          yield* fileSystem.writeFile(
            host.resolveAttachmentPath(attachment)!,
            Uint8Array.from([1, 2]),
          );
        }
        yield* runtime.startTurn({
          ...input,
          message: { ...input.message, attachments, videoFrames },
        });
        while (true) {
          const event = yield* Queue.take(protocolEvents);
          if (event.direction !== "outgoing" || rawProtocolMethod(event) !== "session/prompt")
            continue;
          const blocks = rawProtocolRequestParam(event, "prompt") as Array<{
            type: string;
            text?: string;
            data?: string;
            mimeType?: string;
          }>;
          if (driver === "path-only") {
            const text = blocks.map((block) => block.text ?? "").join("\n");
            assert.include(text, '[Frame of video "clip.mp4" at 00:03.200] saved at: ' + framePath);
            assert.include(text, '[Frame of video "clip.mp4" at 00:07.200] saved at: ' + framePath);
            assert.lengthOf(
              blocks.filter((block) => block.type === "image"),
              0,
            );
          } else {
            if (driver === "antigravity") {
              const images = blocks.filter((block) => block.type === "image");
              assert.lengthOf(images, 3);
              assert.equal(
                images.reduce((sum, image) => sum + Buffer.from(image.data!, "base64").length, 0),
                6,
              );
            }
            const first = blocks.findIndex(
              (block) => block.text === '[Frame of video "clip.mp4" at 00:03.200]',
            );
            assert.isAtLeast(first, 0);
            assert.deepEqual(blocks.slice(first, first + 4), [
              { type: "text", text: '[Frame of video "clip.mp4" at 00:03.200]' },
              { type: "image", data: "CQo=", mimeType: "image/jpeg" },
              { type: "text", text: '[Frame of video "clip.mp4" at 00:07.200]' },
              { type: "image", data: "CQo=", mimeType: "image/jpeg" },
            ]);
          }
          break;
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live.each([
    {
      id: "moved-no-session",
      label: "moved native thread without resumeFromSession",
      pins: true,
      initialNativeThreadCwd: "other" as const,
      resumeFromSessionCwd: undefined,
      resumes: false,
    },
    {
      id: "same-no-session",
      label: "unchanged native thread without resumeFromSession",
      pins: true,
      initialNativeThreadCwd: "same" as const,
      resumeFromSessionCwd: undefined,
      resumes: true,
    },
    {
      id: "legacy-session-cwd",
      label: "legacy fallback to resumeFromSession.cwd",
      pins: true,
      initialNativeThreadCwd: undefined,
      resumeFromSessionCwd: "other" as const,
      resumes: false,
    },
    {
      id: "non-pinning-native",
      label: "non-pinning flavor with moved native thread",
      pins: false,
      initialNativeThreadCwd: "other" as const,
      resumeFromSessionCwd: undefined,
      resumes: true,
    },
    {
      id: "non-pinning-session",
      label: "non-pinning flavor with moved resumeFromSession",
      pins: false,
      initialNativeThreadCwd: undefined,
      resumeFromSessionCwd: "other" as const,
      resumes: true,
    },
  ])(
    "resumes a native session after a workspace move only when the agent honours the new cwd ($label)",
    ({ id, pins, initialNativeThreadCwd, resumeFromSessionCwd, resumes }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
        const instanceId = ProviderInstanceId.make("moved-workspace-" + id);
        const threadId = ThreadId.make("moved-workspace-" + id);
        const currentCwd = process.cwd();
        const removedCwd = path.join(currentCwd, "removed-workspace");
        const resolveCwd = (which: "same" | "other" | undefined) =>
          which === "same" ? currentCwd : which === "other" ? removedCwd : undefined;
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          flavor: {
            driver: ProviderDriverKind.make("acp-test"),
            capabilities: AcpProviderCapabilitiesV2,
            pinsConversationCwd: pins,
            makeRuntime: makeMockRuntime({
              childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
              mockAgentPath: (yield* Deferred.await(bundledAgents)).mock,
              protocolEvents,
            }),
          },
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: currentCwd,
        });
        const modelSelection = { instanceId, model: "default" };
        const now = yield* DateTime.now;
        const recordedCwd = resolveCwd(initialNativeThreadCwd);
        const sessionCwd = resolveCwd(resumeFromSessionCwd);
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("moved-workspace-session-" + id),
          modelSelection,
          runtimePolicy,
          initialNativeThreadId: "old-session",
          ...(recordedCwd === undefined ? {} : { initialNativeThreadCwd: recordedCwd }),
          ...(sessionCwd === undefined
            ? {}
            : {
                resumeFromSession: {
                  id: ProviderSessionId.make("moved-workspace-session-" + id),
                  driver: ProviderDriverKind.make("acp-test"),
                  providerInstanceId: instanceId,
                  status: "stopped",
                  cwd: sessionCwd,
                  model: "default",
                  capabilities: AcpProviderCapabilitiesV2,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
              }),
        });
        const thread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        const methods: Array<string> = [];
        while (true) {
          const event = yield* Queue.take(protocolEvents);
          const method = rawProtocolMethod(event);
          if (event.direction === "outgoing" && method !== undefined) methods.push(method);
          if (method === "session/new" || method === "session/resume" || method === "session/load")
            break;
        }
        assert.equal(
          methods.some((method) => method === "session/resume" || method === "session/load"),
          resumes,
        );
        assert.equal(
          methods.some((method) => method === "session/new"),
          !resumes,
        );
        assert.equal(thread.nativeThreadRef?.nativeId === "old-session", resumes);
        if (pins) {
          assert.equal(thread.nativeMetadata?.conversationCwd, currentCwd);
        } else {
          assert.isUndefined(thread.nativeMetadata?.conversationCwd);
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live(
    "records conversationCwd on new pinning sessions and preserves the recorded value across resumes",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const workspaceA = process.cwd();
        const workspaceB = path.join(workspaceA, "other-workspace");
        const instanceId = ProviderInstanceId.make("conversation-cwd-recording");
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          flavor: {
            driver: ProviderDriverKind.make("acp-test"),
            capabilities: AcpProviderCapabilitiesV2,
            pinsConversationCwd: true,
            makeRuntime: makeMockRuntime({
              childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
              mockAgentPath: (yield* Deferred.await(bundledAgents)).mock,
            }),
          },
        });
        const modelSelection = { instanceId, model: "default" };
        const policyA = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspaceA,
        });
        const policyB = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspaceB,
        });

        // New session records its session cwd on the emitted provider thread.
        const freshThreadId = ThreadId.make("conversation-cwd-fresh");
        const freshRuntime = yield* adapter.openSession({
          threadId: freshThreadId,
          providerSessionId: ProviderSessionId.make("conversation-cwd-fresh-session"),
          modelSelection,
          runtimePolicy: policyA,
        });
        const freshThread = yield* freshRuntime.ensureThread({
          threadId: freshThreadId,
          modelSelection,
          runtimePolicy: policyA,
        });
        assert.equal(freshThread.nativeMetadata?.conversationCwd, workspaceA);
        yield* freshRuntime.startTurn(
          makeTurnInput({
            threadId: freshThreadId,
            providerThread: freshThread,
            instanceId,
            runtimePolicy: policyA,
            now: yield* DateTime.now,
            ordinal: 1,
          }),
        );
        const freshEvents = yield* freshRuntime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const freshUpdated = freshEvents.filter(
          (event) => event.type === "provider_thread.updated",
        );
        assert.isNotEmpty(freshUpdated);
        for (const event of freshUpdated) {
          assert.equal(event.providerThread.nativeMetadata?.conversationCwd, workspaceA);
        }

        // Resumed session keeps the recorded conversationCwd rather than the turn's cwd.
        const resumedThreadId = ThreadId.make("conversation-cwd-resumed");
        const resumedRuntime = yield* adapter.openSession({
          threadId: resumedThreadId,
          providerSessionId: ProviderSessionId.make("conversation-cwd-resumed-session"),
          modelSelection,
          runtimePolicy: policyA,
          initialNativeThreadId: "recorded-session",
          initialNativeThreadCwd: workspaceA,
        });
        const resumedBase = yield* resumedRuntime.ensureThread({
          threadId: resumedThreadId,
          modelSelection,
          runtimePolicy: policyB,
        });
        assert.equal(resumedBase.nativeMetadata?.conversationCwd, workspaceA);
        const resumed = yield* resumedRuntime.resumeThread({
          providerThread: resumedBase,
          modelSelection,
          runtimePolicy: policyB,
        });
        assert.equal(resumed.nativeMetadata?.conversationCwd, workspaceA);
        yield* resumedRuntime.startTurn(
          makeTurnInput({
            threadId: resumedThreadId,
            providerThread: resumed,
            instanceId,
            runtimePolicy: policyB,
            now: yield* DateTime.now,
            ordinal: 2,
          }),
        );
        const resumedEvents = yield* resumedRuntime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const resumedUpdated = resumedEvents.filter(
          (event) => event.type === "provider_thread.updated",
        );
        assert.isNotEmpty(resumedUpdated);
        for (const event of resumedUpdated) {
          assert.equal(event.providerThread.nativeMetadata?.conversationCwd, workspaceA);
        }

        // Resumed legacy session with no recorded cwd stays unrecorded.
        const legacyThreadId = ThreadId.make("conversation-cwd-legacy");
        const legacyRuntime = yield* adapter.openSession({
          threadId: legacyThreadId,
          providerSessionId: ProviderSessionId.make("conversation-cwd-legacy-session"),
          modelSelection,
          runtimePolicy: policyA,
          initialNativeThreadId: "legacy-session",
        });
        const legacyThread = yield* legacyRuntime.ensureThread({
          threadId: legacyThreadId,
          modelSelection,
          runtimePolicy: policyA,
        });
        assert.isUndefined(legacyThread.nativeMetadata?.conversationCwd);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live(
    "leaves non-pinning ensureThread/resumeThread metadata unchanged on startup updates while pinning preserves conversationCwd across session_info_update",
    () =>
      Effect.gen(function* () {
        const workspaceA = process.cwd();
        const policyA = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspaceA,
        });
        const makeStartupTitleAdapter = (pins: boolean, suffix: string) =>
          Effect.gen(function* () {
            type SessionUpdateNotification = Parameters<
              Parameters<AcpSessionRuntime.AcpSessionRuntime["Service"]["handleSessionUpdate"]>[0]
            >[0];
            let sessionUpdateHandler:
              | ((notification: SessionUpdateNotification) => Effect.Effect<void, never, never>)
              | undefined;
            const instanceId = ProviderInstanceId.make(`startup-title-${suffix}`);
            const adapter = yield* makeAcpAdapterV2({
              instanceId,
              selfInvocation: yield* resolveSelfInvocation(),
              flavor: {
                driver: ProviderDriverKind.make("acp-test"),
                capabilities: AcpProviderCapabilitiesV2,
                pinsConversationCwd: pins,
                makeRuntime: makeMockRuntime({
                  childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
                  mockAgentPath: (yield* Deferred.await(bundledAgents)).mock,
                  wrapRuntime: (runtime) => ({
                    ...runtime,
                    handleSessionUpdate: (handler) => {
                      sessionUpdateHandler = (notification) =>
                        handler(notification).pipe(Effect.ignore);
                      return runtime.handleSessionUpdate(handler);
                    },
                    start: () =>
                      runtime.start().pipe(
                        Effect.tap((started) =>
                          sessionUpdateHandler === undefined
                            ? Effect.void
                            : sessionUpdateHandler({
                                sessionId: started.sessionId,
                                update: {
                                  sessionUpdate: "session_info_update",
                                  title: "Startup title",
                                },
                              }),
                        ),
                      ),
                  }),
                }),
              },
            });
            return {
              instanceId,
              adapter,
              emitSessionInfoUpdate: (sessionId: string, title: string) =>
                sessionUpdateHandler === undefined
                  ? Effect.die("missing sessionUpdateHandler")
                  : sessionUpdateHandler({
                      sessionId,
                      update: {
                        sessionUpdate: "session_info_update",
                        title,
                      },
                    }),
            };
          });

        // Non-pinning flavor: startup title is not merged into ensureThread or resumeThread.
        const nonPinning = yield* makeStartupTitleAdapter(false, "non-pinning");
        const nonPinningThreadId = ThreadId.make("startup-title-non-pinning");
        const nonPinningSelection = { instanceId: nonPinning.instanceId, model: "default" };
        const nonPinningRuntime = yield* nonPinning.adapter.openSession({
          threadId: nonPinningThreadId,
          providerSessionId: ProviderSessionId.make("startup-title-non-pinning-session"),
          modelSelection: nonPinningSelection,
          runtimePolicy: policyA,
        });
        const nonPinningThread = yield* nonPinningRuntime.ensureThread({
          threadId: nonPinningThreadId,
          modelSelection: nonPinningSelection,
          runtimePolicy: policyA,
        });
        assert.deepEqual(nonPinningThread.nativeMetadata, { itemIdentityVersion: 2 });
        const nonPinningResumed = yield* nonPinningRuntime.resumeThread({
          providerThread: nonPinningThread,
          modelSelection: nonPinningSelection,
          runtimePolicy: policyA,
        });
        assert.deepEqual(nonPinningResumed.nativeMetadata, { itemIdentityVersion: 2 });

        // Pinning flavor: ensureThread carries conversationCwd (not startup title),
        // and a live session_info_update keeps conversationCwd alongside the new title.
        const pinning = yield* makeStartupTitleAdapter(true, "pinning");
        const pinningThreadId = ThreadId.make("startup-title-pinning");
        const pinningSelection = { instanceId: pinning.instanceId, model: "default" };
        const pinningRuntime = yield* pinning.adapter.openSession({
          threadId: pinningThreadId,
          providerSessionId: ProviderSessionId.make("startup-title-pinning-session"),
          modelSelection: pinningSelection,
          runtimePolicy: policyA,
        });
        const pinningThread = yield* pinningRuntime.ensureThread({
          threadId: pinningThreadId,
          modelSelection: pinningSelection,
          runtimePolicy: policyA,
        });
        assert.deepEqual(pinningThread.nativeMetadata, {
          itemIdentityVersion: 2,
          conversationCwd: workspaceA,
        });
        const pinningSessionId = pinningThread.nativeThreadRef?.nativeId;
        assert.isString(pinningSessionId);
        yield* pinning.emitSessionInfoUpdate(pinningSessionId!, "Updated title");
        const updatedEvent = yield* pinningRuntime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.nativeMetadata?.title === "Updated title",
          ),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(updatedEvent));
        if (Option.isSome(updatedEvent) && updatedEvent.value.type === "provider_thread.updated") {
          assert.equal(updatedEvent.value.providerThread.nativeMetadata?.title, "Updated title");
          assert.equal(
            updatedEvent.value.providerThread.nativeMetadata?.conversationCwd,
            workspaceA,
          );
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live(
    "preserves itemIdentityVersion and conversationCwd on an idle usage update before the first turn",
    () =>
      Effect.gen(function* () {
        const workspaceA = process.cwd();
        const instanceId = ProviderInstanceId.make("pinning-idle-usage");
        const threadId = ThreadId.make("pinning-idle-usage");
        const policyA = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspaceA,
        });
        type SessionUpdateNotification = Parameters<
          Parameters<AcpSessionRuntime.AcpSessionRuntime["Service"]["handleSessionUpdate"]>[0]
        >[0];
        let sessionUpdateHandler:
          | ((notification: SessionUpdateNotification) => Effect.Effect<void, never, never>)
          | undefined;
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          flavor: {
            driver: ProviderDriverKind.make("acp-test"),
            capabilities: AcpProviderCapabilitiesV2,
            pinsConversationCwd: true,
            makeRuntime: makeMockRuntime({
              childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
              mockAgentPath: (yield* Deferred.await(bundledAgents)).mock,
              wrapRuntime: (runtime) => ({
                ...runtime,
                handleSessionUpdate: (handler) => {
                  sessionUpdateHandler = (notification) =>
                    handler(notification).pipe(Effect.ignore);
                  return runtime.handleSessionUpdate(handler);
                },
              }),
            }),
          },
        });
        const modelSelection = { instanceId, model: "default" };
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("pinning-idle-usage-session"),
          modelSelection,
          runtimePolicy: policyA,
        });
        const thread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: policyA,
        });
        assert.deepEqual(thread.nativeMetadata, {
          itemIdentityVersion: 2,
          conversationCwd: workspaceA,
        });
        const sessionId = thread.nativeThreadRef?.nativeId;
        assert.isString(sessionId);
        assert.isDefined(sessionUpdateHandler);
        yield* sessionUpdateHandler!({
          sessionId: sessionId!,
          update: {
            sessionUpdate: "usage_update",
            used: 123,
            size: 1000,
          },
        });
        const usageEvent = yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.contextUsage?.usedTokens === 123,
          ),
          Stream.runHead,
        );
        assert.isTrue(Option.isSome(usageEvent));
        if (Option.isSome(usageEvent) && usageEvent.value.type === "provider_thread.updated") {
          assert.deepEqual(usageEvent.value.providerThread.nativeMetadata, {
            itemIdentityVersion: 2,
            conversationCwd: workspaceA,
          });
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
