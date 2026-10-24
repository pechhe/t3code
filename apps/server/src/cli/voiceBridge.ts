// @effect-diagnostics nodeBuiltinImport:off -- The bridge keeps its session map and capture scratch file beside the CLI's other local state, and owns its listening socket.

import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { HttpRouter } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { captureFrontWindow } from "../voiceBridge/Capture.ts";
import * as CaptureSession from "../voiceBridge/CaptureSession.ts";
import { routes } from "../voiceBridge/Http.ts";
import {
  isFluidVoiceRecording,
  startMacCommandShortcut,
  toggleFluidVoiceCommand,
} from "../voiceBridge/MacCommandShortcut.ts";
import { decodeSessions, EMPTY_SESSIONS, type SessionStore } from "../voiceBridge/Sessions.ts";
import { makePort } from "../voiceBridge/T3Port.ts";
import * as AgentCliClient from "./AgentCliClient.ts";

const endpointFlag = Flag.String("endpoint").pipe(
  Flag.withDescription(
    "T3 environment MCP URL the bridge speaks to, such as http://127.0.0.1:3773/mcp.",
  ),
);
const credentialsDirFlag = Flag.String("credentials-dir").pipe(
  Flag.withDescription(
    "Absolute directory holding this CLI's credentials. Defaults to the one `t3 agent login` uses.",
  ),
  Flag.optional,
);
const portFlag = Flag.Int("port").pipe(
  Flag.withDescription("Port the bridge listens on. Default: 4319."),
  Flag.withDefault(4319),
);
const hostFlag = Flag.String("host").pipe(
  Flag.withDescription("Address the bridge listens on. Default: 127.0.0.1."),
  Flag.withDefault("127.0.0.1"),
);
const captureFlag = Flag.Boolean("capture").pipe(
  Flag.withDescription("Attach a capture of the window that had focus. Default: on for macOS."),
  Flag.optional,
);
const pollFlag = Flag.Int("poll-ms").pipe(
  Flag.withDescription("How often to read the thread for new text. Default: 600."),
  Flag.withDefault(600),
);
const commandShortcutFlag = Flag.Boolean("command-shortcut").pipe(
  Flag.withDescription("On macOS, Control-Option-Command-V captures before starting FluidVoice."),
  Flag.withDefault(false),
);
const waitFlag = Flag.Int("wait-seconds").pipe(
  Flag.withDescription(
    "How long to stream one answer before pointing at the thread. Default: 900.",
  ),
  Flag.withDefault(900),
);

const sessionFile = Schema.fromJsonString(Schema.Unknown);

/** The CLI's own credentials, so one `t3 agent login` serves the bridge too. */
export const resolveBridgeCredentialsDirectory = (
  directory: Option.Option<string>,
  home = NodeOS.homedir(),
): string =>
  Option.isSome(directory) ? directory.value : NodePath.join(home, ".t3", "agent-clients");

type BridgeFlags = {
  readonly endpoint: string;
  readonly credentialsDir: Option.Option<string>;
  readonly port: number;
  readonly host: string;
  readonly capture: Option.Option<boolean>;
  readonly commandShortcut: boolean;
  readonly pollMs: number;
  readonly waitSeconds: number;
};

const readSessions = Effect.fn("voiceBridge.readSessions")(function* (
  fileSystem: FileSystem.FileSystem,
  sessionsPath: string,
) {
  const text = yield* fileSystem
    .readFileString(sessionsPath)
    .pipe(Effect.catch(() => Effect.succeed("")));
  if (text.trim() === "") return EMPTY_SESSIONS;
  const decoded = yield* Schema.decodeUnknownEffect(sessionFile)(text).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  return decodeSessions(decoded);
});

const runBridge = (flags: BridgeFlags) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const platform = yield* HostProcess.Platform;
      const captureEnabled = Option.getOrElse(flags.capture, () => platform === "darwin");
      const stateDir = NodePath.join(NodeOS.homedir(), ".t3", "voice-bridge");
      yield* fileSystem.makeDirectory(stateDir, { recursive: true }).pipe(Effect.orDie);
      const sessionsPath = NodePath.join(stateDir, "sessions.json");
      const capturePath = NodePath.join(stateDir, "capture.png");

      const client = yield* AgentCliClient.AgentCliClient;
      const captures = yield* CaptureSession.CaptureSession.pipe(
        Effect.provide(
          Layer.effect(
            CaptureSession.CaptureSession,
            CaptureSession.make(() =>
              captureEnabled
                ? Effect.promise(() => captureFrontWindow(capturePath)).pipe(
                    Effect.tap((captured) =>
                      captured === null
                        ? Effect.logWarning(
                            "Screenshot capture failed; sending text only. Check Screen Recording permission and that a window is visible.",
                          )
                        : Effect.void,
                    ),
                  )
                : Effect.succeed(null),
            ),
          ),
        ),
      );
      if (flags.commandShortcut) {
        if (platform !== "darwin")
          return yield* Effect.die(new Error("The command shortcut requires macOS."));
        let triggering = false;
        yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            startMacCommandShortcut({
              helperPath: NodePath.join(stateDir, "command-shortcut.swift"),
              onTrigger: () => {
                if (triggering) return;
                triggering = true;
                void Effect.runPromise(
                  captures
                    .invoke({
                      isRecording: Effect.tryPromise((signal) => isFluidVoiceRecording(signal)),
                      toggle: Effect.tryPromise((signal) => toggleFluidVoiceCommand(signal)),
                    })
                    .pipe(
                      Effect.catch((error) =>
                        captures.clear().pipe(Effect.andThen(Effect.logError(error))),
                      ),
                      Effect.ensuring(
                        Effect.sync(() => {
                          triggering = false;
                        }),
                      ),
                    ),
                );
              },
              onCancel: () => {
                void Effect.runPromise(captures.clear());
              },
              onFailure: (error) => {
                void Effect.runPromise(Effect.logError(error));
              },
            }),
          ),
          (stop) => Effect.sync(stop),
        );
      }
      const deps = {
        port: makePort(client, flags.endpoint),
        capture: captures.take,
        sessions: {
          read: () => readSessions(fileSystem, sessionsPath),
          write: (store: SessionStore) =>
            fileSystem
              .writeFileString(sessionsPath, JSON.stringify(store))
              .pipe(Effect.catch(() => Effect.void)),
        },
        pollIntervalMs: flags.pollMs,
        maxWaitMs: flags.waitSeconds * 1_000,
      };

      yield* Layer.build(
        HttpRouter.serve(routes({ deps }), { disableListenLog: true }).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(() => NodeHttp.createServer(), {
              host: flags.host,
              port: flags.port,
            }),
          ),
        ),
      );
      yield* Console.log(
        [
          `T3 voice bridge listening on http://${flags.host}:${flags.port}`,
          `FluidVoice provider server URL: http://${flags.host}:${flags.port}/v1`,
          captureEnabled ? "Capturing the front window with each ask." : "Sending words only.",
          ...(flags.commandShortcut
            ? ["Control-Option-Command-V starts/stops FluidVoice with an initial screenshot."]
            : []),
        ].join("\n"),
      );
      return yield* Effect.never;
    }),
  );

export const voiceBridgeCommand = Command.make("voice-bridge", {
  endpoint: endpointFlag,
  credentialsDir: credentialsDirFlag,
  port: portFlag,
  host: hostFlag,
  capture: captureFlag,
  commandShortcut: commandShortcutFlag,
  pollMs: pollFlag,
  waitSeconds: waitFlag,
}).pipe(
  Command.withDescription(
    "Serve an OpenAI-compatible endpoint that turns FluidVoice's dictated asks into T3 threads.",
  ),
  Command.withHandler((flags) =>
    runBridge(flags).pipe(
      Effect.provide(
        AgentCliClient.layer.pipe(
          Layer.provide(
            ServerSecretStore.layerAtDirectory(
              resolveBridgeCredentialsDirectory(flags.credentialsDir),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  ),
);
