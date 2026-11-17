// @effect-diagnostics nodeBuiltinImport:off - a script's own process signals stop its run.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  BROWSER_RUN_PATH,
  BROWSER_RUN_TOKEN_ENV,
  BROWSER_RUN_URL_ENV,
} from "@t3tools/provider-core/server/mcpSession";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { BROWSER_RUN_HEADER, BROWSER_RUN_LIMITS } from "../browserRuns/BrowserRuns.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession, type McpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import { AGENT_THREAD_ENV } from "../preview/PortScanner.ts";
import { readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import { baseDirFlag, resolveCliAuthConfig } from "./config.ts";

const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  ),
});

const decodeToolResult = Schema.decodeUnknownOption(ToolResult);
const decodeFailureText = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** `t3_browser_run_close`'s summary, which the command reports as its `run`. */
export interface BrowserRunSummary {
  readonly runId: string;
  readonly outcome: string;
  readonly durationMs: number;
  readonly tabs: number;
  readonly outputBytes: number;
}

/** Exactly what `t3 browser run` prints: one JSON object, whatever the script did. */
export interface BrowserRunOutput {
  readonly ok: boolean;
  readonly result: unknown;
  readonly error?: string;
  /** Null when no run could be opened, or the server would not say how it ended. */
  readonly run: BrowserRunSummary | null;
}

/** A tool result as a script sees it: its value, or the reason it failed. */
export type ToolOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

const textPart = (result: typeof ToolResult.Type): string | undefined =>
  result.content?.find((part) => part.text !== undefined)?.text;

/** `structuredContent`, else text content parsed as JSON when it is, else as text. */
export const readToolOutcome = (raw: unknown): ToolOutcome => {
  const decoded = decodeToolResult(raw);
  if (Option.isNone(decoded)) {
    return { ok: false, error: "The server sent an unexpected tool result." };
  }
  const result = decoded.value;
  if (result.isError === true) {
    const text = textPart(result) ?? "";
    return {
      ok: false,
      error: Option.match(decodeFailureText(text), {
        onNone: () => text || "The tool call failed.",
        onSome: (failure) => failure.message,
      }),
    };
  }
  if (result.structuredContent !== undefined) return { ok: true, value: result.structuredContent };
  const text = textPart(result);
  if (text === undefined) return { ok: true, value: null };
  const parsed = decodeJson(text);
  return { ok: true, value: Option.isSome(parsed) ? parsed.value : text };
};

/** The script outlived its run; its own work may still be running in this process. */
export const SCRIPT_OUTLIVED_RUN =
  "The script was stopped when the run's time limit passed. The server has closed its tabs.";

export const exitCodeFor = (output: BrowserRunOutput): number => (output.ok ? 0 : 1);

/** One JSON object, always naming `ok`, `result` and `run`, with `error` only on failure. */
export const formatBrowserRunOutput = (output: BrowserRunOutput): string =>
  JSON.stringify({
    ok: output.ok,
    result: output.result ?? null,
    ...(output.error === undefined ? {} : { error: output.error }),
    run: output.run,
  });

export interface BrowserRunScriptContext {
  readonly tools: Readonly<
    Record<string, (input?: Readonly<Record<string, unknown>>) => Promise<unknown>>
  >;
  readonly args: ReadonlyArray<string>;
  readonly run: { readonly runId: string; readonly deadline: string };
}

/**
 * The script's `tools`: any tool name, its input passed through. A failing call rejects with an
 * Error carrying the server's reason, so a script can let it end the run.
 */
export const scriptTools = (
  call: (
    tool: string,
    input: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, BrowserRunToolError>,
): BrowserRunScriptContext["tools"] =>
  new Proxy(
    {},
    {
      get: (_target, tool) =>
        typeof tool === "string"
          ? (input?: Readonly<Record<string, unknown>>) =>
              Effect.runPromise(call(tool, input ?? {}))
          : undefined,
    },
  ) as BrowserRunScriptContext["tools"];

export interface BrowserRunPossibility {
  readonly url: string;
  readonly token: string;
}

/** The credential an agent's own commands are given for its thread's run lane. */
export const credentialFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): BrowserRunPossibility | null => {
  const url = environment[BROWSER_RUN_URL_ENV];
  const token = environment[BROWSER_RUN_TOKEN_ENV];
  return url !== undefined && url.length > 0 && token !== undefined && token.length > 0
    ? { url, token }
    : null;
};

export const authorizationFor = (token: string): string =>
  token.startsWith("Bearer ") ? token : `Bearer ${token}`;

/** Node strips a TypeScript script's types itself, so relative imports resolve as in any module. */
const importScript = (scriptPath: string): Promise<unknown> =>
  import(NodeURL.pathToFileURL(NodePath.resolve(scriptPath)).href);

/** A session to the run endpoint, which names each run it opens on its later calls. */
const runSession = Effect.fn("cli.browserRun.runSession")(function* (input: {
  readonly endpoint: string;
  readonly authorization: string;
}) {
  let runId: string | undefined;
  const session = yield* mcpToolSession({
    endpoint: input.endpoint,
    authorization: input.authorization,
    clientName: "t3-browser-run-cli",
    extraHeaders: () => (runId === undefined ? {} : { [BROWSER_RUN_HEADER]: runId }),
  });
  return {
    session,
    nameRun: (next: string) => {
      runId = next;
    },
  };
});

export class BrowserRunToolError extends Schema.TaggedError<BrowserRunToolError>()(
  "BrowserRunToolError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class BrowserRunFailedError extends Schema.TaggedError<BrowserRunFailedError>()(
  "BrowserRunFailedError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

const failed = (detail: string, result: unknown = null): BrowserRunOutput => ({
  ok: false,
  result,
  error: detail,
  run: null,
});

/**
 * Signs in as a short-lived MCP client of the running server, the same way `t3 thread` does, and
 * revokes that session when the command ends. Outside a thread the CLI acts as the machine's
 * owner, so its run names the project holding the current directory.
 */
const withLocalSession = Effect.fn("cli.browserRun.withLocalSession")(function* <A, E, R>(
  baseDir: Option.Option<string>,
  run: (session: McpToolSession, nameRun: (runId: string) => void) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig({ baseDir }, logLevel, { quietLogs: true });
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new BrowserRunFailedError({
        detail: `No running T3 Code server uses ${config.baseDir}. Start T3 Code, then retry.`,
      });
    }
    const origin = runtimeState.value.origin;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* Effect.acquireRelease(
      environmentAuth.issueMcpClientSession({
        label: "t3 browser run cli",
        access: "full-access",
        peerLink: false,
        client: { deviceType: "bot" },
      }),
      (session) =>
        environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
    const { session, nameRun } = yield* runSession({
      endpoint: new URL(BROWSER_RUN_PATH, origin).href,
      authorization: `Bearer ${issued.token}`,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new BrowserRunFailedError({
            detail: `Could not reach the T3 Code server at ${origin}.`,
            cause,
          }),
      ),
    );
    return yield* run(session, nameRun);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );
});

/** One tool call, its failure reduced to the text a script or the output reports. */
const callTool = (
  session: McpToolSession,
  tool: string,
  input: Readonly<Record<string, unknown>>,
): Effect.Effect<ToolOutcome> =>
  session.call(tool, input).pipe(
    Effect.map(readToolOutcome),
    Effect.catchTags({
      AcpMcpBridgeError: (cause): Effect.Effect<ToolOutcome> =>
        Effect.succeed({ ok: false, error: cause.message }),
    }),
  );

export interface BrowserRunScriptRun {
  /** A session whose extra headers name the run, once there is one. */
  readonly session: McpToolSession;
  /** Names the run every later call belongs to; `t3 browser run` keeps it. */
  readonly nameRun: (runId: string) => void;
  /** Sent to `t3_browser_run_open` only outside a thread, where it names the project. */
  readonly workspace: string | undefined;
  readonly scriptPath: string;
  readonly args: ReadonlyArray<string>;
  readonly timeLimitSeconds: number | undefined;
  readonly outputLimitBytes: number | undefined;
}

/**
 * Opens a run, loads the script, lets it drive the run and closes it however the script ends,
 * including on interruption and once the run's deadline passes.
 */
export const runBrowserScript = Effect.fn("cli.browserRun.runScript")(function* (
  input: BrowserRunScriptRun,
): Effect.fn.Return<BrowserRunOutput> {
  const { session } = input;
  const opened = yield* callTool(session, "t3_browser_run_open", {
    ...(input.timeLimitSeconds === undefined ? {} : { timeLimitSeconds: input.timeLimitSeconds }),
    ...(input.outputLimitBytes === undefined ? {} : { outputLimitBytes: input.outputLimitBytes }),
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
  });
  if (!opened.ok) return failed(opened.error);
  const openedRun = opened.value as { runId: string; deadline: string };
  const runId = openedRun.runId;
  // Every call after the open names its run; the credential alone does not.
  input.nameRun(runId);

  const close = (outcome: "succeeded" | "failed") =>
    session.call("t3_browser_run_close", { outcome }).pipe(
      Effect.map(readToolOutcome),
      Effect.map((read) => (read.ok ? (read.value as BrowserRunSummary) : null)),
      Effect.orElseSucceed(() => null),
    );

  const deadlineMs = Date.parse(openedRun.deadline);
  const remaining = () =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) =>
        Number.isNaN(deadlineMs) ? BROWSER_RUN_LIMITS.defaultSeconds * 1_000 : deadlineMs - now,
      ),
    );

  const script = Effect.gen(function* () {
    const context: BrowserRunScriptContext = {
      tools: scriptTools((tool, args) =>
        callTool(session, tool, args).pipe(
          Effect.flatMap((outcome) =>
            outcome.ok
              ? Effect.succeed(outcome.value)
              : Effect.fail(new BrowserRunToolError({ detail: outcome.error })),
          ),
        ),
      ),
      args: input.args,
      run: { runId, deadline: openedRun.deadline },
    };
    const loaded = yield* Effect.tryPromise({
      try: () => importScript(input.scriptPath),
      catch: (cause) =>
        new BrowserRunFailedError({
          detail: `Could not load ${input.scriptPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });
    const handler =
      typeof loaded === "object" && loaded !== null
        ? (loaded as { default?: unknown }).default
        : undefined;
    if (typeof handler !== "function") {
      return yield* new BrowserRunFailedError({
        detail: `${input.scriptPath} must default-export an async function.`,
      });
    }
    return yield* Effect.tryPromise({
      try: () => Promise.resolve((handler as (c: BrowserRunScriptContext) => unknown)(context)),
      catch: (cause) =>
        new BrowserRunFailedError({
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  });

  const finish = Effect.gen(function* () {
    // A script that outlives the deadline stops being waited for; the server closed its tabs.
    const outcome = yield* remaining().pipe(
      Effect.flatMap((limitMs) =>
        script.pipe(Effect.timeoutOption(Duration.millis(Math.max(0, limitMs)))),
      ),
      Effect.result,
    );
    const succeeded = Result.isSuccess(outcome);
    const summary = yield* close(succeeded ? "succeeded" : "failed");
    if (!succeeded) {
      return {
        ok: false,
        result: null,
        error: outcome.failure.message,
        run: summary,
      } satisfies BrowserRunOutput;
    }
    if (Option.isNone(outcome.success)) {
      return {
        ok: false,
        result: null,
        error: SCRIPT_OUTLIVED_RUN,
        run: summary,
      } satisfies BrowserRunOutput;
    }
    return {
      ok: true,
      result: outcome.success.value,
      run: summary,
    } satisfies BrowserRunOutput;
  });

  // A run left open closes at its deadline; closing it now frees its tabs sooner.
  return yield* Effect.onInterrupt(finish, () => close("failed").pipe(Effect.asVoid));
});

/**
 * Prints the one JSON object and sets the exit code; ends the process when the script outlived its run.
 * @public A test imports it from a generated script, which knip cannot see.
 */
export const reportBrowserRunOutput = (output: BrowserRunOutput): Effect.Effect<void> =>
  output.error === SCRIPT_OUTLIVED_RUN
    ? // Its promise cannot be cancelled, so the process ends with it once the report is out.
      Effect.callback<void>(() => {
        process.stdout.write(`${formatBrowserRunOutput(output)}\n`, () =>
          process.exit(exitCodeFor(output)),
        );
      })
    : Effect.sync(() => {
        process.stdout.write(`${formatBrowserRunOutput(output)}\n`);
        if (!output.ok) process.exitCode = exitCodeFor(output);
      });

const runCommand = Command.make("run", {
  baseDir: baseDirFlag,
  script: Argument.String("script").pipe(
    Argument.withDescription("An ES module file (js, mjs or ts) default-exporting the script."),
  ),
  args: Argument.String("args").pipe(
    Argument.withDescription("Arguments for the script, after --."),
    Argument.variadic({ min: 0 }),
  ),
  timeLimit: Flag.Int("time-limit").pipe(
    Flag.withDescription(
      `How long the run may take, up to ${BROWSER_RUN_LIMITS.maxSeconds} seconds. Defaults to ${BROWSER_RUN_LIMITS.defaultSeconds}.`,
    ),
    Flag.optional,
  ),
  outputLimit: Flag.Int("output-limit").pipe(
    Flag.withDescription(
      `How much browser output the run may return, in bytes, up to ${BROWSER_RUN_LIMITS.maxOutputBytes}.`,
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Run a browser script as the calling agent in a T3 thread, or as this machine's owner for the project holding the current directory outside one.",
  ),
  Command.withHandler(({ baseDir, script, args, timeLimit, outputLimit }) =>
    Effect.gen(function* () {
      const environment = yield* HostProcess.Environment;
      const credential = credentialFromEnvironment(environment);
      const cwd = yield* HostProcess.WorkingDirectory;
      const begin = (
        session: McpToolSession,
        workspace: string | undefined,
        nameRun: (runId: string) => void,
      ) =>
        runBrowserScript({
          session,
          workspace,
          nameRun,
          scriptPath: script,
          args,
          timeLimitSeconds: Option.getOrUndefined(timeLimit),
          outputLimitBytes: Option.getOrUndefined(outputLimit),
        });

      // Inside an agent's thread only its own run credential may drive the browser: the
      // owner's local session would hand page code to roles that are refused it.
      const inAgentThread =
        (environment[AGENT_THREAD_ENV] ?? "") !== "" ||
        (environment[BROWSER_RUN_URL_ENV] ?? "") !== "";
      if (credential === null && inAgentThread) {
        return yield* new BrowserRunFailedError({
          detail:
            "This agent's thread has no browser-run credential: its role or project does not allow browser scripts.",
        });
      }
      const output =
        credential === null
          ? yield* withLocalSession(baseDir, (session, nameRun) =>
              begin(session, NodePath.resolve(cwd), nameRun),
            )
          : yield* Effect.scoped(
              Effect.gen(function* () {
                const { session, nameRun } = yield* runSession({
                  endpoint: credential.url,
                  authorization: authorizationFor(credential.token),
                });
                return yield* begin(session, undefined, nameRun);
              }),
            );

      yield* reportBrowserRunOutput(output);
    }).pipe(
      Effect.catchTags({
        BrowserRunFailedError: (cause) =>
          Effect.sync(() => {
            process.stdout.write(`${formatBrowserRunOutput(failed(cause.message))}\n`);
            process.exitCode = 1;
          }),
      }),
    ),
  ),
);

export const browserRunCommand = runCommand;
