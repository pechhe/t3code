// @effect-diagnostics preferSchemaOverJson:off schemaSyncInEffect:off -- Fixed runner source needs JSON string-literal escaping; response decoding is enclosed in Effect.try.
import type { PreviewViewportSetting } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";

import { PHI_RUNNER_PROGRAM, type PhiOperation } from "./PhiBrowserProtocol.ts";

export class PhiBrowserRunnerError extends Schema.TaggedError<PhiBrowserRunnerError>()(
  "PhiBrowserRunnerError",
  {
    reason: Schema.Literals([
      "missing-skill",
      "connection-failed",
      "invalid-response",
      "human-control",
      "login-required",
      "action-failed",
      "user-space-unavailable",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "missing-skill":
        return "Phi's installed skill runner is missing. Check the configured phi-browser skill directory.";
      case "connection-failed":
        return "Phi's runner could not complete the operation. Check Phi and the skill's Mac connection route; no other browser was substituted.";
      case "invalid-response":
        return "Phi's runner returned an invalid response. Check the installed phi-browser skill version.";
      case "human-control":
        return "The human controls the Phi Space. Wait for explicit hand-back before resuming.";
      case "login-required":
        return "The shadow page requires human sign-in through the Agents lane.";
      case "action-failed":
        return "Phi could not complete the page action.";
      case "user-space-unavailable":
        return "Phi could not reach a tab in the user's own Space.";
    }
  }
}

export interface PhiBrowserRound {
  readonly skillDirectory?: string;
  readonly context:
    | {
        readonly kind: "shadow";
        readonly name: string;
        readonly profile?: string;
        readonly incognito: true;
      }
    | {
        readonly kind: "agent";
        readonly name: "Agents";
        readonly persistent: true;
      }
    | {
        readonly kind: "user";
        /** Unset only on open, which binds the window the user is looking at. */
        readonly window?: number;
      };
  /** On a user-lane open, take over the tab the user has selected instead of opening one. */
  readonly attachFocusedTab?: true;
  readonly readHumanMessages?: boolean;
  /** Reach Phi without allocating a browser resource. */
  readonly probe?: true;
  readonly expectedWindow?: number;
  readonly targetId?: string;
  /** A unique blank URL allocated before the owned tab's identifier is returned. */
  readonly allocationUrl?: string;
  /** The tab's size from its last preview_resize, applied again on every round. */
  readonly viewport?: PreviewViewportSetting;
  readonly action: PhiOperation;
  readonly timeoutMs: number;
}

const RunnerReply = Schema.Struct({
  result: Schema.Unknown,
  context: Schema.Unknown,
  failure: Schema.optional(
    Schema.Literals(["human-control", "login-required", "action-failed", "user-space-unavailable"]),
  ),
});
const decodeReply = Schema.decodeUnknownSync(RunnerReply);

/** Only the fixed adapter program reaches the installed runner's Node surface. */
export class PhiBrowserRunner extends Context.Service<
  PhiBrowserRunner,
  {
    readonly run: (
      request: PhiBrowserRound,
    ) => Effect.Effect<typeof RunnerReply.Type, PhiBrowserRunnerError>;
  }
>()("t3/preview/PhiBrowserRunner") {}

const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const run = Effect.fn("PhiBrowserRunner.run")(function* (request: PhiBrowserRound) {
    const configuredDirectory = request.skillDirectory;
    const directory = configuredDirectory?.trim()
      ? configuredDirectory.startsWith("~/")
        ? path.join(home, configuredDirectory.slice(2))
        : configuredDirectory
      : path.join(home, ".agents", "skills", "phi-browser");
    const runner = path.join(directory, "scripts", "runner.mjs");
    const exists = yield* fs
      .exists(runner)
      .pipe(
        Effect.mapError((cause) => new PhiBrowserRunnerError({ reason: "missing-skill", cause })),
      );
    if (!exists)
      return yield* new PhiBrowserRunnerError({ reason: "missing-skill", cause: undefined });
    // JSON string decoding keeps even quotes, backticks and line separators in
    // user text as data. No shell parses the command or its stdin.
    const { skillDirectory: _skillDirectory, timeoutMs: _timeoutMs, ...data } = request;
    // The skill runner calls process.exit() as soon as this script returns, which drops
    // whatever part of a reply larger than the pipe buffer is still unwritten (every
    // snapshot carries a screenshot). Wait for stdout to drain first.
    const source = `const request = JSON.parse(${JSON.stringify(JSON.stringify(data))});
try {
  await (async () => {
${PHI_RUNNER_PROGRAM}
  })();
} catch (error) {
  if (typeof error?.message === 'string' && error.message.startsWith('user is controlling')) {
    cliLog(JSON.stringify({t3Phi: {result: null, context: null, failure: 'human-control'}}));
  } else if (error?.t3Failure === 'user-space-unavailable' ||
      ['user_space_operations_disabled', 'no_focused_window', 'window_not_open', 'space_not_open'].includes(error?.reply?.error)) {
    // Phi refuses the user's Space when its agent setting is off or the window has gone.
    cliLog(JSON.stringify({t3Phi: {result: null, context: null, failure: 'user-space-unavailable'}}));
  } else throw error;
} finally {
  await new Promise((resolve) => process.stdout.write('', resolve));
}`;
    const output = yield* processRunner
      .run({
        command: "node",
        args: [runner],
        stdin: source,
        // Connection/attachment precedes the helper's own deadline. Let that
        // deadline report its outcome before the process watchdog expires.
        timeout: request.probe
          ? request.timeoutMs
          : Math.max(request.timeoutMs, (request.action.timeout ?? 0) * 1000) + 10_000,
        maxOutputBytes: 16 * 1024 * 1024,
      })
      .pipe(
        Effect.mapError(
          (cause) => new PhiBrowserRunnerError({ reason: "connection-failed", cause }),
        ),
      );
    if (output.code !== 0 || output.timedOut) {
      return yield* new PhiBrowserRunnerError({ reason: "connection-failed", cause: output });
    }
    const reply = yield* Effect.try({
      try: () => {
        // cliLog emits one JSON object per line. Other skill narration is not
        // an adapter response; never treat it as instructions or code.
        const replies = output.stdout.split("\n").flatMap((line): Array<unknown> => {
          try {
            const value: unknown = JSON.parse(line);
            return typeof value === "object" && value !== null && "t3Phi" in value
              ? [value.t3Phi]
              : [];
          } catch {
            return [];
          }
        });
        if (replies.length !== 1) throw new Error("Expected one Phi adapter reply");
        return decodeReply(replies[0]);
      },
      catch: (cause) => new PhiBrowserRunnerError({ reason: "invalid-response", cause }),
    });
    if (reply.failure !== undefined)
      return yield* new PhiBrowserRunnerError({ reason: reply.failure, cause: undefined });
    return reply;
  });
  return PhiBrowserRunner.of({ run });
});

export const layer = Layer.effect(PhiBrowserRunner, make);
