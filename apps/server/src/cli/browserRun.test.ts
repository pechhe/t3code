// @effect-diagnostics nodeBuiltinImport:off -- The test runs the command's report in a real child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NetService from "@t3tools/shared/Net";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Command } from "effect/cli";

/** What the command prints: one JSON object, the run summary or nothing. */
const Output = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    error: Schema.optional(Schema.String),
    run: Schema.NullOr(Schema.Unknown),
  }),
);
const decodeOutput = Schema.decodeEffect(Output);

import type { McpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import {
  authorizationFor,
  browserRunCommand,
  credentialFromEnvironment,
  exitCodeFor,
  formatBrowserRunOutput,
  readToolOutcome,
  SCRIPT_OUTLIVED_RUN,
  BrowserRunToolError,
  runBrowserScript,
  scriptTools,
  type BrowserRunOutput,
} from "./browserRun.ts";

const browserRunToolError = (message: string) => new BrowserRunToolError({ detail: message });

/** A session that answers each tool from `answer`, recording what it was asked and its headers. */
const fakeSession = (
  answer: (tool: string, input: Readonly<Record<string, unknown>>) => unknown,
): McpToolSession & {
  readonly calls: Array<{ tool: string; input: Readonly<Record<string, unknown>> }>;
} => {
  const calls: Array<{ tool: string; input: Readonly<Record<string, unknown>> }> = [];
  return {
    calls,
    call: (tool, input) =>
      Effect.sync(() => {
        calls.push({ tool, input });
        return answer(tool, input);
      }),
  };
};

const OPEN = (deadline: string) => ({
  structuredContent: { runId: "run-1", deadline, outputLimitBytes: 1_024 },
});

const CLOSE = {
  structuredContent: {
    runId: "run-1",
    outcome: "succeeded",
    durationMs: 12,
    tabs: 1,
    outputBytes: 8,
  },
};

/** Runs a script from a temporary file, as `t3 browser run` does. */
const runScript = (
  source: string,
  session: McpToolSession,
  scriptArgs = ["one", "two"],
  filename = "script.mjs",
) =>
  Effect.gen(function* () {
    const naming: Array<string> = [];
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-browser-run-script-" });
    const scriptPath = path.join(dir, filename);
    yield* fs.writeFileString(scriptPath, source);
    const output = yield* runBrowserScript({
      session,
      nameRun: (runId) => naming.push(runId),
      workspace: undefined,
      scriptPath,
      args: scriptArgs,
      timeLimitSeconds: undefined,
      outputLimitBytes: undefined,
    });
    return { ...output, naming };
  });

const deadlineIn = (ms: number) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    return DateTime.formatIso(DateTime.addDuration(now, Duration.millis(ms)));
  });

describe("t3 browser run credential", () => {
  it("uses the agent's own browser-run variables when both are set", () => {
    assert.deepEqual(
      credentialFromEnvironment({
        T3_BROWSER_RUN_URL: "http://127.0.0.1:43123/mcp/browser-run",
        T3_BROWSER_RUN_TOKEN: "browser-run-token",
      }),
      { url: "http://127.0.0.1:43123/mcp/browser-run", token: "browser-run-token" },
    );
  });

  it("falls back to the CLI's own sign-in unless both are set", () => {
    for (const environment of [
      {},
      { T3_BROWSER_RUN_URL: "http://127.0.0.1:43123/mcp/browser-run" },
      { T3_BROWSER_RUN_TOKEN: "browser-run-token" },
      { T3_BROWSER_RUN_URL: "", T3_BROWSER_RUN_TOKEN: "browser-run-token" },
    ])
      assert.isNull(credentialFromEnvironment(environment));
  });

  it("sends the token as a bearer, which the endpoint accepts once", () => {
    assert.equal(authorizationFor("raw-token"), "Bearer raw-token");
    assert.equal(authorizationFor("Bearer raw-token"), "Bearer raw-token");
  });
});

describe("t3 browser run results", () => {
  it("reads a tool's value from structuredContent, then from text content", () => {
    assert.deepEqual(readToolOutcome({ structuredContent: { tabId: "tab-1" } }), {
      ok: true,
      value: { tabId: "tab-1" },
    });
    assert.deepEqual(readToolOutcome({ content: [{ type: "text", text: '{"value":3}' }] }), {
      ok: true,
      value: { value: 3 },
    });
    assert.deepEqual(readToolOutcome({ content: [{ type: "text", text: "plain" }] }), {
      ok: true,
      value: "plain",
    });
  });

  it("carries the server's reason for a failed call", () => {
    assert.deepEqual(
      readToolOutcome({
        isError: true,
        content: [
          { type: "text", text: JSON.stringify({ code: "capability_denied", message: "Off." }) },
        ],
      }),
      { ok: false, error: "Off." },
    );
    assert.deepEqual(
      readToolOutcome({ isError: true, content: [{ type: "text", text: "Bad." }] }),
      { ok: false, error: "Bad." },
    );
  });

  it("prints one JSON object that always names ok, result and run", () => {
    assert.deepEqual(
      JSON.parse(
        formatBrowserRunOutput({ ok: false, error: "Off.", result: undefined, run: null }),
      ),
      { ok: false, result: null, error: "Off.", run: null },
    );
  });

  it("exits 0 only when the script succeeded", () => {
    const output = (ok: boolean): BrowserRunOutput => ({ ok, result: null, run: null });
    assert.equal(exitCodeFor(output(true)), 0);
    assert.equal(exitCodeFor(output(false)), 1);
    assert.deepEqual(JSON.parse(formatBrowserRunOutput(output(true))), output(true));
  });

  it.effect("returns the script's tools, rejecting with the server's reason", () =>
    Effect.gen(function* () {
      const tools = scriptTools((tool, input) =>
        tool === "preview_open"
          ? Effect.succeed({ tabId: "tab-1", ...input })
          : Effect.fail(browserRunToolError("No such tool.")),
      );
      assert.deepEqual(
        yield* Effect.promise(() => tools.preview_open!({ url: "https://x.test" })),
        {
          tabId: "tab-1",
          url: "https://x.test",
        },
      );
      const failure = yield* Effect.promise(() =>
        tools.preview_navigate!({ tabId: "tab-1" }).then(
          () => null,
          (cause: unknown) => cause,
        ),
      );
      assert.equal((failure as Error).message, "No such tool.");
    }),
  );
});

describe("t3 browser run script", () => {
  it.effect("opens a run, names it on later calls, and closes it with the script's result", () =>
    Effect.gen(function* () {
      const deadline = yield* deadlineIn(60_000);
      const session = fakeSession((tool) =>
        tool === "t3_browser_run_open"
          ? OPEN(deadline)
          : tool === "t3_browser_run_close"
            ? CLOSE
            : { structuredContent: { ok: true } },
      );
      const output = yield* runScript(
        `export default async ({ tools, args, run }) => {
           await tools.preview_open({ url: "https://example.test" });
           return { args, runId: run.runId };
         };`,
        session,
      );
      assert.isTrue(output.ok);
      assert.deepEqual(output.result, { args: ["one", "two"], runId: "run-1" });
      assert.deepEqual(output.run, CLOSE.structuredContent);
      assert.deepEqual(
        session.calls.map((call) => call.tool),
        ["t3_browser_run_open", "preview_open", "t3_browser_run_close"],
      );
      // The run id rides on every call after the open, never on the credential.
      assert.deepEqual(output.naming, ["run-1"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("loads a TypeScript script, whose types Node strips", () =>
    Effect.gen(function* () {
      const deadline = yield* deadlineIn(60_000);
      const session = fakeSession((tool) =>
        tool === "t3_browser_run_open" ? OPEN(deadline) : CLOSE,
      );
      const output = yield* runScript(
        `type Context = { args: string[]; run: { runId: string } };
         export default async ({ args, run }: Context): Promise<unknown> => ({
           first: args[0],
           runId: run.runId,
         });`,
        session,
        ["one"],
        "script.ts",
      );
      assert.isTrue(output.ok, output.error);
      assert.deepEqual(output.result, { first: "one", runId: "run-1" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a failing tool call, so the script can let it end the run", () =>
    Effect.gen(function* () {
      const deadline = yield* deadlineIn(60_000);
      const session = fakeSession((tool) =>
        tool === "t3_browser_run_open"
          ? OPEN(deadline)
          : tool === "t3_browser_run_close"
            ? CLOSE
            : { isError: true, content: [{ type: "text", text: "No tab holds that id." }] },
      );
      const output = yield* runScript(
        `export default async ({ tools }) => {
           await tools.preview_navigate({ tabId: "tab-1" });
           return "unreachable";
         };`,
        session,
      );
      assert.isFalse(output.ok);
      assert.equal(output.error, "No tab holds that id.");
      assert.equal(session.calls.at(-1)!.input.outcome, "failed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a thrown error, closes the run and carries the reason", () =>
    Effect.gen(function* () {
      const deadline = yield* deadlineIn(60_000);
      const session = fakeSession((tool) =>
        tool === "t3_browser_run_open" ? OPEN(deadline) : CLOSE,
      );
      const output = yield* runScript(
        'export default async () => { throw new Error("Broken step."); };',
        session,
      );
      assert.isFalse(output.ok);
      assert.equal(output.error, "Broken step.");
      assert.deepEqual(
        session.calls.map((call) => call.tool),
        ["t3_browser_run_open", "t3_browser_run_close"],
      );
      assert.equal(session.calls.at(-1)!.input.outcome, "failed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails when the file has no default-exported function", () =>
    Effect.gen(function* () {
      const deadline = yield* deadlineIn(60_000);
      const session = fakeSession((tool) =>
        tool === "t3_browser_run_open" ? OPEN(deadline) : CLOSE,
      );
      const output = yield* runScript("export const notDefault = 1;", session);
      assert.isFalse(output.ok);
      assert.include(output.error ?? "", "must default-export an async function");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops waiting at the run's deadline and reports failure", () =>
    Effect.gen(function* () {
      const deadline = yield* deadlineIn(-1_000);
      const session = fakeSession((tool) =>
        tool === "t3_browser_run_open" ? OPEN(deadline) : CLOSE,
      );
      const output = yield* runScript("export default async () => new Promise(() => {});", session);
      assert.isFalse(output.ok);
      assert.include(output.error ?? "", "time limit");
      assert.equal(session.calls.at(-1)!.tool, "t3_browser_run_close");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a refused open without calling anything else", () =>
    Effect.gen(function* () {
      const session = fakeSession(() => ({
        isError: true,
        content: [
          { type: "text", text: "Integrated agent browsing is turned off for this project." },
        ],
      }));
      const output = yield* runScript("export default async () => 1;", session);
      assert.isFalse(output.ok);
      assert.equal(output.error, "Integrated agent browsing is turned off for this project.");
      assert.isNull(output.run);
      assert.deepEqual(
        session.calls.map((call) => call.tool),
        ["t3_browser_run_open"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.live(
  "ends the process when a script outlived its run, whatever the script still holds open",
  () =>
    Effect.promise(async () => {
      const module = NodeURL.pathToFileURL(
        NodePath.resolve(import.meta.dirname, "browserRun.ts"),
      ).href;
      // The script's own timer would keep the process alive forever if the report did not end it.
      const program = `
      import * as Effect from "effect/Effect";
      import { reportBrowserRunOutput, SCRIPT_OUTLIVED_RUN } from ${JSON.stringify(module)};
      setInterval(() => {}, 1000);
      Effect.runPromise(reportBrowserRunOutput({ ok: false, result: null, error: SCRIPT_OUTLIVED_RUN, run: null }));
    `;
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["--input-type=module", "-e", program],
        {
          cwd: NodePath.resolve(import.meta.dirname, "../.."),
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      const [code] = await NodeEvents.EventEmitter.once(child, "exit");
      assert.equal(code, 1);
      assert.include(stdout, SCRIPT_OUTLIVED_RUN);
    }),
);

describe("t3 browser run command", () => {
  /** Runs the command, capturing what it prints and the exit code it leaves behind. */
  const runCommand = (args: ReadonlyArray<string>) => {
    const written: string[] = [];
    const previousWrite = process.stdout.write.bind(process.stdout);
    const previousExitCode = process.exitCode;
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    return Effect.gen(function* () {
      yield* Command.runWith(browserRunCommand, { version: "0.0.0" })(args).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      return { written: written.join(""), exitCode: process.exitCode };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          process.stdout.write = previousWrite;
          process.exitCode = previousExitCode;
        }),
      ),
    );
  };

  it.effect("takes script arguments after -- and reports one JSON object when no server runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-browser-run-cli-" });
      const { written, exitCode } = yield* runCommand([
        "script.mjs",
        "--base-dir",
        path.join(baseDir, "state"),
        "one",
        "--",
        "two",
        "--three",
      ]);
      // Parsing succeeded: only the missing server is reported, as one JSON object and exit 1.
      const output = yield* decodeOutput(written.trim()).pipe(Effect.orDie);
      assert.isFalse(output.ok);
      assert.include(output.error ?? "", "No running T3 Code server");
      assert.equal(exitCode, 1);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, NodeCrypto.layer))),
  );

  it.effect("refuses inside an agent's thread that was given no browser-run credential", () =>
    Effect.gen(function* () {
      const { written, exitCode } = yield* runCommand(["script.mjs"]).pipe(
        Effect.provideService(HostProcess.Environment, { T3CODE_THREAD_ID: "thread-1" }),
      );
      const output = yield* decodeOutput(written.trim()).pipe(Effect.orDie);
      assert.include(output.error ?? "", "no browser-run credential");
      assert.equal(exitCode, 1);
      // Providers that set no thread id still mark their commands with the endpoint alone.
      const marked = yield* runCommand(["script.mjs"]).pipe(
        Effect.provideService(HostProcess.Environment, {
          T3_BROWSER_RUN_URL: "http://127.0.0.1:1/mcp/browser-run",
        }),
      );
      assert.include(
        (yield* decodeOutput(marked.written.trim()).pipe(Effect.orDie)).error ?? "",
        "no browser-run credential",
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, NodeCrypto.layer))),
  );
});
