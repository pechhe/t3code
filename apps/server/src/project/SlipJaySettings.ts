import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  SlipJayCommandError,
  SlipJayLandingCheck,
  SlipJayPolicySetPhase,
  SlipJayProcessLevel,
  type VcsSlipJayMachineSettings,
  type VcsSlipJayPolicyOutcome,
  type VcsSlipJayProjectSettings,
  type VcsSlipJayProjectSettingsInput,
  type VcsSlipJayRunnerControlInput,
  type VcsSlipJaySetPolicyInput,
  type VcsSlipJaySetPolicyResult,
  type VcsSlipJaySetRunnerInput,
  type VcsSlipJaySetSpareLimitInput,
} from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import { findSlipJayProject } from "../vcs/SlipJayProject.ts";
import { SlipJayLandings } from "./SlipJayLandings.ts";

const Strings = Schema.optional(Schema.Array(Schema.String));

// `slipjay policy show --json`: the integration branch's committed policy.
const decodePolicy = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      integrationBranch: Schema.String,
      revision: Schema.String,
      declared: Schema.Struct({
        releaseBranch: Schema.optional(Schema.String),
        sharedPaths: Strings,
        generatedPaths: Strings,
        tracker: Schema.optional(Schema.String),
      }),
      settings: Schema.Struct({
        spares: Schema.Number,
        process: SlipJayProcessLevel,
        requiredLandingVerification: Schema.Array(SlipJayLandingCheck),
      }),
    }),
  ),
);

// `slipjay config --json`: this machine's runner location and spare limits.
const decodeConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      runner: Schema.Struct({
        value: Schema.NullOr(Schema.String),
        file: Schema.NullOr(Schema.String),
        overriddenByEnvironment: Schema.Boolean,
      }),
      spares: Schema.Array(
        Schema.Struct({
          repository: Schema.String,
          machineLimit: Schema.NullOr(Schema.Number),
          effective: Schema.Number,
        }),
      ),
    }),
  ),
);

// `slipjay policy set --json-lines`: a `following` line once the runner has the change, then
// the outcome. Older SlipJay prints only the outcome, pretty-printed.
const decodePolicySetLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ phase: Schema.Literal("following"), operationId: Schema.String }),
      Schema.Struct({
        phase: SlipJayPolicySetPhase,
        revision: Schema.optional(Schema.String),
        reason: Schema.optional(Schema.String),
      }),
    ]),
  ),
);

// The `--patch` `slipjay policy set` takes: only the fields being changed.
const encodePatch = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      spares: Schema.optional(Schema.Number),
      process: Schema.optional(SlipJayProcessLevel),
      requiredLandingVerification: Schema.optional(Schema.Array(SlipJayLandingCheck)),
    }),
  ),
);

/**
 * A project's settings from `slipjay policy show --json` and `slipjay config --json`, both run
 * in its checkout; `repository` is that checkout as SlipJay names it. None when either is unreadable.
 */
export function projectSettings(
  policyStdout: string,
  configStdout: string,
  repository: string,
): VcsSlipJayProjectSettings | undefined {
  const policy = Option.getOrUndefined(decodePolicy(policyStdout.trim()));
  const config = Option.getOrUndefined(decodeConfig(configStdout.trim()));
  if (policy === undefined || config === undefined) return undefined;
  const spares = config.spares.find((entry) => entry.repository === repository);
  return {
    integrationBranch: policy.integrationBranch,
    revision: policy.revision,
    spares: policy.settings.spares,
    process: policy.settings.process,
    requiredLandingVerification: policy.settings.requiredLandingVerification,
    releaseBranch: policy.declared.releaseBranch ?? null,
    sharedPaths: policy.declared.sharedPaths ?? [],
    generatedPaths: policy.declared.generatedPaths ?? [],
    tracker: policy.declared.tracker ?? "github",
    machineSpares: {
      machineLimit: spares?.machineLimit ?? null,
      effective: spares?.effective ?? policy.settings.spares,
    },
  };
}

/** This machine's runner from `slipjay config --json`; none when it is unreadable. */
export function machineSettings(configStdout: string): VcsSlipJayMachineSettings | undefined {
  const config = Option.getOrUndefined(decodeConfig(configStdout.trim()));
  if (config === undefined) return undefined;
  return {
    available: true,
    runner: config.runner.value,
    runnerInFile: config.runner.file,
    overriddenByEnvironment: config.runner.overriddenByEnvironment,
  };
}

/** One line of `slipjay policy set --json-lines`; none when it is not one SlipJay prints. */
export function policySetLine(line: string): VcsSlipJaySetPolicyResult | undefined {
  const result = Option.getOrUndefined(decodePolicySetLine(line.trim()));
  if (result === undefined) return undefined;
  if (result.phase === "following")
    return result.operationId === ""
      ? undefined
      : { phase: "following", operationId: result.operationId };
  return { phase: result.phase, revision: result.revision ?? null, reason: result.reason ?? null };
}

/** `slipjay policy set`'s outcome, its last line; none when it printed none. */
export function policySetResult(stdout: string): VcsSlipJayPolicyOutcome | undefined {
  const lines = stdout.trim().split("\n");
  const result = policySetLine(lines.at(-1) ?? "") ?? policySetLine(stdout);
  if (result === undefined || result.phase === "following") return undefined;
  // SlipJay before 3.27.0 refuses `--json-lines` as a usage error.
  return result.phase === "refused" && result.reason?.startsWith("Usage:")
    ? { ...result, reason: "Saving here needs SlipJay 3.27.0 or later on this machine." }
    : result;
}

const OUTPUT_MAX_BYTES = 1024 * 1024;
const UNAVAILABLE: VcsSlipJayMachineSettings = {
  available: false,
  runner: null,
  runnerInFile: null,
  overriddenByEnvironment: false,
};

/**
 * SlipJay's settings, always through its own commands: this machine's runner location and
 * spare limits (`slipjay config`), and a project's shared policy (`slipjay policy`), whose
 * changes land through the runner without its landing checks.
 */
export class SlipJaySettings extends Context.Service<
  SlipJaySettings,
  {
    readonly project: (
      input: VcsSlipJayProjectSettingsInput,
    ) => Effect.Effect<VcsSlipJayProjectSettings, SlipJayCommandError>;
    /**
     * Lands a policy change, resolving once the runner has it with the operation to follow, or
     * with its outcome if it ends first. The landing outlives the request; asking again with the
     * same change while it runs resolves with its outcome.
     */
    readonly setPolicy: (
      input: VcsSlipJaySetPolicyInput,
    ) => Effect.Effect<VcsSlipJaySetPolicyResult, SlipJayCommandError>;
    readonly setSpareLimit: (
      input: VcsSlipJaySetSpareLimitInput,
    ) => Effect.Effect<VcsSlipJayProjectSettings, SlipJayCommandError>;
    readonly machine: Effect.Effect<VcsSlipJayMachineSettings, SlipJayCommandError>;
    /** Changes the runner this machine lands through, and follows the new one. */
    readonly setRunner: (
      input: VcsSlipJaySetRunnerInput,
    ) => Effect.Effect<VcsSlipJayMachineSettings, SlipJayCommandError>;
    readonly controlRunner: (
      input: VcsSlipJayRunnerControlInput,
    ) => Effect.Effect<{}, SlipJayCommandError>;
  }
>()("t3/project/SlipJaySettings") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const processes = yield* ProcessRunner.ProcessRunner;
  const landings = yield* SlipJayLandings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;

  const failure = (
    operation: string,
    command: string,
    cwd: string,
    detail: string,
    cause?: unknown,
  ) =>
    new SlipJayCommandError({
      operation,
      command,
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const run = (
    args: ReadonlyArray<string>,
    options: {
      readonly cwd?: string;
      readonly timeout: ProcessRunner.ProcessRunInput["timeout"];
      readonly onStdoutChunk?: ProcessRunner.ProcessRunInput["onStdoutChunk"];
    },
    onError: (cause: unknown) => SlipJayCommandError,
  ) =>
    processes
      .run({
        command: "slipjay",
        args: [...args],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.onStdoutChunk === undefined ? {} : { onStdoutChunk: options.onStdoutChunk }),
        timeout: options.timeout,
        maxOutputBytes: OUTPUT_MAX_BYTES,
        outputMode: "truncate",
      })
      .pipe(Effect.mapError(onError));

  // Only a SlipJay project's own checkout, so a client cannot run SlipJay anywhere else.
  // SlipJay names a repository by its checkout's real path.
  const projectRoot = (cwd: string, operation: string, command: string) =>
    findSlipJayProject(cwd).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, processes),
      Effect.orElseSucceed(() => null),
      Effect.flatMap((project) =>
        project === null
          ? Effect.fail(failure(operation, command, cwd, "This is not a SlipJay project."))
          : fs.realPath(project.root).pipe(Effect.orElseSucceed(() => project.root)),
      ),
    );

  const readProject = Effect.fn("SlipJaySettings.readProject")(function* (
    root: string,
    operation: string,
  ) {
    const onError = (cause: unknown) =>
      failure(operation, "slipjay policy show", root, "SlipJay could not be run.", cause);
    const [policy, config] = yield* Effect.all(
      [
        run(["policy", "show", "--json"], { cwd: root, timeout: "1 minute" }, onError),
        run(["config", "--json"], { cwd: root, timeout: "30 seconds" }, onError),
      ],
      { concurrency: 2 },
    );
    const settings =
      policy.code === 0 && config.code === 0
        ? projectSettings(policy.stdout, config.stdout, root)
        : undefined;
    // SlipJay's stderr can carry runner URLs and paths, so it stays on the server.
    if (settings === undefined)
      return yield* failure(
        operation,
        "slipjay policy show",
        root,
        "SlipJay could not read this project's settings. Run `slipjay policy show` in the project for details.",
      );
    return settings;
  });

  const project: SlipJaySettings["Service"]["project"] = Effect.fn("SlipJaySettings.project")(
    function* ({ cwd }) {
      const root = yield* projectRoot(cwd, "SlipJaySettings.project", "slipjay policy show");
      return yield* readProject(root, "SlipJaySettings.project");
    },
  );

  interface PolicySave {
    readonly following: Deferred.Deferred<VcsSlipJaySetPolicyResult, SlipJayCommandError>;
    readonly outcome: Deferred.Deferred<VcsSlipJayPolicyOutcome, SlipJayCommandError>;
  }
  const saves = yield* Ref.make(new Map<string, PolicySave>());

  const runPolicySet = (root: string, args: ReadonlyArray<string>, save: PolicySave) => {
    const operation = "SlipJaySettings.setPolicy";
    const command = "slipjay policy set";
    let pending = "";
    const decoder = new TextDecoder();
    return run(
      args,
      {
        cwd: root,
        // It waits its turn in the runner's queue; the landing itself skips the checks.
        timeout: "1 hour",
        onStdoutChunk: (chunk) => {
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            const result = policySetLine(line);
            if (result?.phase === "following")
              Deferred.doneUnsafe(save.following, Effect.succeed(result));
          }
        },
      },
      (cause) => failure(operation, command, root, "SlipJay could not be run.", cause),
    ).pipe(
      Effect.flatMap((output) => {
        const result = policySetResult(output.stdout);
        return result === undefined
          ? Effect.fail(
              failure(
                operation,
                command,
                root,
                "SlipJay printed no outcome. Run `slipjay policy show` in the project to see where it stands.",
              ),
            )
          : Effect.succeed(result);
      }),
      Effect.onExit((exit) =>
        Effect.all([Deferred.done(save.outcome, exit), Deferred.done(save.following, exit)]),
      ),
    );
  };

  const setPolicy: SlipJaySettings["Service"]["setPolicy"] = Effect.fn("SlipJaySettings.setPolicy")(
    function* ({ cwd, base, ...fields }) {
      const root = yield* projectRoot(cwd, "SlipJaySettings.setPolicy", "slipjay policy set");
      const patch = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(patch).length === 0)
        return { phase: "already-applied", revision: base, reason: null };
      const args = ["policy", "set", "--json-lines", "--base", base, "--patch", encodePatch(patch)];
      const key = [root, ...args].join("\0");
      // Registering and starting are one step, so an interrupted caller cannot leave a
      // registration that no run will ever settle.
      const { save, joined } = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const started: PolicySave = {
            following: yield* Deferred.make<VcsSlipJaySetPolicyResult, SlipJayCommandError>(),
            outcome: yield* Deferred.make<VcsSlipJayPolicyOutcome, SlipJayCommandError>(),
          };
          const running = yield* Ref.modify(saves, (current) => {
            const existing = current.get(key);
            return existing === undefined
              ? [undefined, new Map(current).set(key, started)]
              : [existing, current];
          });
          if (running !== undefined) return { save: running, joined: true };
          yield* runPolicySet(root, args, started).pipe(
            Effect.ensuring(
              Ref.update(saves, (current) => {
                const next = new Map(current);
                next.delete(key);
                return next;
              }),
            ),
            Effect.forkIn(scope),
          );
          return { save: started, joined: false };
        }),
      );
      // A second ask for the same change is the client following up for the outcome.
      return joined ? yield* Deferred.await(save.outcome) : yield* Deferred.await(save.following);
    },
  );

  const setSpareLimit: SlipJaySettings["Service"]["setSpareLimit"] = Effect.fn(
    "SlipJaySettings.setSpareLimit",
  )(function* ({ cwd, limit }) {
    const operation = "SlipJaySettings.setSpareLimit";
    const command = "slipjay config";
    const root = yield* projectRoot(cwd, operation, command);
    const output = yield* run(
      limit === null
        ? ["config", "unset", "spares", "--repo", root]
        : ["config", "set", "spares", String(limit), "--repo", root],
      { cwd: root, timeout: "30 seconds" },
      (cause) => failure(operation, command, root, "SlipJay could not be run.", cause),
    );
    if (output.code !== 0)
      return yield* failure(operation, command, root, "SlipJay refused the spare limit.");
    return yield* readProject(root, operation);
  });

  const readMachine = (operation: string) =>
    run(["config", "--json"], { timeout: "30 seconds" }, (cause) =>
      failure(operation, "slipjay config", "", "SlipJay could not be run.", cause),
    ).pipe(
      Effect.map((output) => (output.code === 0 ? machineSettings(output.stdout) : undefined)),
      // A host without SlipJay, or with one older than its settings commands, has none.
      Effect.orElseSucceed(() => undefined),
      Effect.map((settings) => settings ?? UNAVAILABLE),
    );

  const machine = readMachine("SlipJaySettings.machine");

  const setRunner: SlipJaySettings["Service"]["setRunner"] = Effect.fn("SlipJaySettings.setRunner")(
    function* ({ location }) {
      const operation = "SlipJaySettings.setRunner";
      const command = "slipjay config";
      const output = yield* run(
        location === null ? ["config", "unset", "runner"] : ["config", "set", "runner", location],
        { timeout: "30 seconds" },
        (cause) => failure(operation, command, "", "SlipJay could not be run.", cause),
      );
      if (output.code !== 0)
        return yield* failure(operation, command, "", "SlipJay refused the runner location.");
      // Operations already submitted stay on the runner that accepted them; the overview follows the new one.
      yield* landings.followRunnerChange;
      return yield* readMachine(operation);
    },
  );

  const controlRunner: SlipJaySettings["Service"]["controlRunner"] = Effect.fn(
    "SlipJaySettings.controlRunner",
  )(function* ({ action }) {
    const operation = "SlipJaySettings.controlRunner";
    const command = `slipjay runner ${action}`;
    const output = yield* run(["runner", action], { timeout: "90 seconds" }, (cause) =>
      failure(operation, command, "", "SlipJay could not be run.", cause),
    );
    if (output.code !== 0)
      return yield* failure(
        operation,
        command,
        "",
        `SlipJay could not ${action} the runner. Run \`${command}\` on the server for details.`,
      );
    return {};
  });

  return SlipJaySettings.of({
    project,
    setPolicy,
    setSpareLimit,
    machine,
    setRunner,
    controlRunner,
  });
});

export const layer = Layer.effect(SlipJaySettings, make).pipe(Layer.provide(ProcessRunner.layer));
