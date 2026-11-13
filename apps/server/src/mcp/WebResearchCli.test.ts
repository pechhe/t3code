import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as WebResearch from "./WebResearch.ts";

const fixture = Effect.fn("WebResearchCli.test.fixture")(function* (mode = "success") {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-executor-cli-" });
  const script = `${root}/executor.mjs`;
  const command = platform === "win32" ? `${root}/executor.cmd` : script;
  const pidFile = `${root}/pid`;
  yield* fs.writeFileString(
    script,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const mode = process.env.EXECUTOR_TEST_MODE;
if (process.argv.includes('--version')) {
  console.log(mode === 'old' ? 'executor v2.0.0-beta.25' : 'executor v2.0.0-beta.46');
  process.exit(0);
}
writeFileSync(process.env.EXECUTOR_TEST_PID_FILE, String(process.pid));
if (mode === 'auth') { console.error(process.env.EXECUTOR_ACCESS_TOKEN); process.exit(1); }
if (process.argv.slice(2).join(' ') !== 'mcp --host https://api.executor.sh') process.exit(2);
if (process.env.EXECUTOR_ACCESS_TOKEN !== 'fixture-secret') process.exit(3);
const input = createInterface({ input: process.stdin });
input.on('close', () => process.exit(0));
input.on('line', line => {
  const request = JSON.parse(line);
  if (!('id' in request)) return;
  if (mode === 'overflow') { process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1)); return; }
  if (mode === 'malformed') { console.log('invalid json'); process.exit(0); }
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : { content: [], structuredContent: { path: request.params.arguments.calls.path, ok: true, value: { results: [{ title: 'Source', url: 'https://example.com', content: 'Snippet' }] } } };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
});
`,
  );
  if (platform === "win32") {
    yield* fs.writeFileString(command, `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    yield* fs.chmod(command, 0o700);
  }
  const client = WebResearch.layerExecutor.pipe(
    Layer.provide(ProcessRunner.layer),
    Layer.provide(
      Layer.succeed(WebResearch.ExecutorCredentialSource, {
        read: Effect.succeed("fixture-secret"),
      }),
    ),
    Layer.provide(
      Layer.succeed(HostProcess.Environment, {
        T3CODE_EXECUTOR_PATH: mode === "missing" ? `${root}/missing-executor` : command,
        EXECUTOR_TEST_MODE: mode,
        EXECUTOR_TEST_PID_FILE: pidFile,
      }),
    ),
  );
  return { client, pidFile };
});

it.live("uses hosted CLI stdio with a private credential and closes it after a search", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const f = yield* fixture();
    const result = yield* Effect.gen(function* () {
      const web = yield* WebResearch.WebResearch;
      return yield* web.search({ query: "question" });
    }).pipe(Effect.provide(WebResearch.layer.pipe(Layer.provide(f.client))));
    expect(result).toEqual([{ title: "Source", url: "https://example.com", snippet: "Snippet" }]);
    const pid = Number(yield* fs.readFileString(f.pidFile));
    expect(() => process.kill(pid, 0)).toThrow();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.each(["old", "missing", "auth", "malformed", "overflow"])(
  "fails safely for a %s CLI",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture(mode);
      const failure = yield* Effect.gen(function* () {
        const client = yield* WebResearch.ExecutorWebClient;
        return yield* client.connect;
      }).pipe(Effect.scoped, Effect.provide(f.client), Effect.flip);
      expect(failure.stage).toBe(mode === "old" || mode === "missing" ? "cli" : "connection");
      expect(failure.message).not.toContain("fixture-secret");
      expect(failure.message).toContain("Executor CLI");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("closes the CLI when its owning scope is interrupted", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const f = yield* fixture();
    const connected = yield* Deferred.make<void>();
    const fiber = yield* Effect.gen(function* () {
      const client = yield* WebResearch.ExecutorWebClient;
      yield* client.connect;
      yield* Deferred.succeed(connected, undefined);
      return yield* Effect.never;
    }).pipe(Effect.scoped, Effect.provide(f.client), Effect.forkScoped);
    yield* Deferred.await(connected);
    const pid = Number(yield* fs.readFileString(f.pidFile));
    yield* Fiber.interrupt(fiber);
    expect(() => process.kill(pid, 0)).toThrow();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
