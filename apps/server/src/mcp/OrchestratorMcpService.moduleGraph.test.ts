// @effect-diagnostics nodeBuiltinImport:off -- Runs the real module graph through Node's own ESM loader.
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const moduleUrl = (path: string) => new NodeURL.URL(path, import.meta.url).href;

it.live("loads the orchestrator toolkit after the service its tools depend on", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // The toolkit reads the service class as its module evaluates, so a cycle back through
    // the service throws in Node's loader but not in the test transform.
    const script =
      `await import(${JSON.stringify(moduleUrl("./OrchestratorMcpService.ts"))});` +
      `const { OrchestratorToolkit } = await import(${JSON.stringify(moduleUrl("./toolkits/orchestrator/tools.ts"))});` +
      `console.log(OrchestratorToolkit.tools.t3_thread_send.name);`;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, ["--input-type=module", "--eval", script]),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    expect(exitCode, stderr).toBe(0);
    expect(stdout.trim()).toBe("t3_thread_send");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
