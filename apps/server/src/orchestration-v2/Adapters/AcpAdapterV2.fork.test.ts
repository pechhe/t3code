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
});
