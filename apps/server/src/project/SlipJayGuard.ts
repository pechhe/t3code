import * as NodeOS from "node:os";

import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import { findSlipJayProject } from "../vcs/SlipJayProject.ts";

/**
 * Whether one command a provider agent wants to run may run, decided by the same
 * `slipjay guard` a harness hook runs. T3 keeps no rules of its own here: it asks
 * SlipJay and reports the answer, so a rule added to the guard reaches every driver
 * at once and no second implementation can drift from it.
 *
 * A call outside a SlipJay repository must stay cheap, and a driver pays this on
 * every command, so the two questions are cached: whether this directory is
 * governed at all (answered without running anything in the common case), and the
 * verdict for a directory and command. A guard that cannot run allows the call, as
 * the hooks do.
 */
export interface SlipJayGuardDecision {
  readonly allowed: boolean;
  /** The guard's own message when it denied the call. */
  readonly reason: string | null;
}

export interface SlipJayGuardInput {
  /** The command's working directory, which is what the guard reads the policy above. */
  readonly cwd: string;
  /** The shell command as the agent wrote it. */
  readonly command: string;
}

export class SlipJayGuard extends Context.Service<
  SlipJayGuard,
  {
    readonly check: (input: SlipJayGuardInput) => Effect.Effect<SlipJayGuardDecision>;
    /**
     * Whether the guard would judge anything here at all. A driver pays a round trip
     * for every command once it routes them through an approval, so it asks first.
     */
    readonly governs: (directory: string) => Effect.Effect<boolean>;
  }
>()("t3/project/SlipJayGuard") {}

const ALLOWED: SlipJayGuardDecision = { allowed: true, reason: null };

/**
 * Whether a command's verdict can move with the working copy it runs against. A
 * `jj` invocation can run anywhere in a shell line (`cd x && jj new`, `FOO=1 jj
 * abandon`, a pipeline), so the word is matched wherever it appears rather than only
 * at the start.
 */
const isStateDependentCommand = (command: string) =>
  /(?:^|[\s;&|()"'`/.])jj(?:$|[\s;&|)`])/.test(command);

// The hooks add these to PATH because a thread starts with a thin environment.
const GUARD_PATH_ENTRIES = [".bun/bin", ".local/bin"];
const GUARD_TIMEOUT = "20 seconds";
// Long enough that a busy agent does not pay twice for one answer, short enough that a
// newly guarded repository or an edited policy is not trusted for long.
const MEMO_TIME_TO_LIVE = Duration.seconds(30);
const MEMO_CAPACITY = 512;

const hookInput = Schema.fromJsonString(
  Schema.Struct({
    tool_name: Schema.String,
    tool_input: Schema.Struct({ command: Schema.String }),
    cwd: Schema.String,
  }),
);

const encodeHookInput = Schema.encodeSync(hookInput);

const decodeHookOutput = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      hookSpecificOutput: Schema.Struct({
        permissionDecision: Schema.String,
        permissionDecisionReason: Schema.optional(Schema.String),
      }),
    }),
  ),
);

/** The guard's message when its hook output denies the call; null for anything else. */
const guardDenial = (stdout: string): string | null => {
  const output = Option.getOrUndefined(decodeHookOutput(stdout.trim()));
  if (output?.hookSpecificOutput.permissionDecision !== "deny") return null;
  return (
    output.hookSpecificOutput.permissionDecisionReason ??
    "SlipJay guard denied this command in a SlipJay repository."
  );
};

const guardPath = (): string => {
  const home = NodeOS.homedir();
  const already = (process.env.PATH ?? "").split(":").filter(Boolean);
  const preferred = GUARD_PATH_ENTRIES.map((entry) => `${home}/${entry}`).filter(
    (entry) => !already.includes(entry),
  );
  return [...preferred, ...already].join(":");
};

const make = Effect.gen(function* () {
  const processes = yield* ProcessRunner.ProcessRunner;

  // The one reader of "is this a SlipJay project" the server already has: a Jujutsu
  // workspace holding slipjay.json, or one whose integration bookmark commits it.
  // Deciding that here is only a cost shortcut; the guard still re-reads the policy
  // when T3 runs it, so nothing depends on this answer being the guard's own.
  const isGoverned = (directory: string) =>
    findSlipJayProject(directory).pipe(Effect.map((project) => project !== null));

  /** Runs the guard for a governed directory; null when it could not run. */
  const runGuard = Effect.fnUntraced(function* (input: SlipJayGuardInput) {
    const output = yield* processes
      .run({
        command: "slipjay",
        args: ["guard"],
        cwd: input.cwd,
        env: { ...process.env, PATH: guardPath() },
        stdin: encodeHookInput({
          tool_name: "Bash",
          tool_input: { command: input.command },
          cwd: input.cwd,
        }),
        timeout: GUARD_TIMEOUT,
        maxOutputBytes: 64 * 1024,
      })
      .pipe(Effect.orElseSucceed(() => null));
    // A guard that cannot run lets the call through, exactly as the hooks do.
    if (output === null || output.code !== 0) return ALLOWED;
    const reason = guardDenial(output.stdout);
    return reason === null ? ALLOWED : { allowed: false, reason };
  });

  const governed = yield* Cache.make({
    capacity: MEMO_CAPACITY,
    timeToLive: MEMO_TIME_TO_LIVE,
    lookup: isGoverned,
  });
  const answers = yield* Cache.make({
    capacity: MEMO_CAPACITY,
    timeToLive: MEMO_TIME_TO_LIVE,
    lookup: (key: string) => {
      const newline = key.indexOf("\n");
      const input = { cwd: key.slice(0, newline), command: key.slice(newline + 1) };
      return Cache.get(governed, input.cwd).pipe(
        Effect.flatMap((is) => (is ? runGuard(input) : Effect.succeed(ALLOWED))),
      );
    },
  });

  // A guard that cannot answer, for any reason, must not block the agent: the hooks
  // let the call through when the guard fails, and so does T3.
  //
  // A jj verdict depends on the working copy it runs against: `jj new` is refused
  // while `@` holds undescribed work and allowed a moment later, so caching it would
  // refuse a retry the agent has just earned, or allow one it has not. Those commands
  // ask every time; a branch push's answer does not move with the working copy.
  const check = Effect.fn("SlipJayGuard.check")((input: SlipJayGuardInput) =>
    isStateDependentCommand(input.command)
      ? Cache.get(governed, input.cwd).pipe(
          Effect.flatMap((is) => (is ? runGuard(input) : Effect.succeed(ALLOWED))),
          Effect.orElseSucceed(() => ALLOWED),
        )
      : Cache.get(answers, `${input.cwd}\n${input.command}`).pipe(
          Effect.orElseSucceed(() => ALLOWED),
        ),
  );

  return SlipJayGuard.of({
    check,
    governs: (directory) => Cache.get(governed, directory).pipe(Effect.orElseSucceed(() => false)),
  });
});

export const layer = Layer.effect(SlipJayGuard, make);

/**
 * The one guard layer the server provides. Every consumer shares this value so they
 * share its caches: the adapters' `CommandGuard` port and the MCP toolkit that Pi
 * asks both reach one guard, not one per consumer.
 */
export const sharedLayer = layer.pipe(Layer.provide(ProcessRunner.layer));
export { make };
