import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeVM from "node:vm";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as PhiBrowserRunner from "./PhiBrowserRunner.ts";

const round: PhiBrowserRunner.PhiBrowserRound = {
  context: { kind: "shadow", name: "task-id", incognito: true },
  action: { operation: "status" },
  timeoutMs: 1000,
};

const setup = (
  options: { missing?: boolean; execute?: boolean; stdout?: string; code?: number } = {},
) => {
  const calls: Array<ProcessRunner.ProcessRunInput> = [];
  const paths: Array<string> = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        calls.push(input);
        const lines: Array<string> = [];
        if (options.execute) {
          const context = NodeVM.createContext({
            enterContext: async () => ({ windowId: 7 }),
            currentContext: () => ({ kind: "shadow", windowId: 7 }),
            listTabs: async () => [],
            listAgentSpaces: async () => [],
            observe: async () => ({ elements: [] }),
            typeText: async (text: string) => text,
            cliLog: (text: string) => lines.push(text),
          });
          yield* Effect.tryPromise(() =>
            NodeVM.runInContext(`(async () => {${input.stdin}\n})()`, context),
          );
        }
        return {
          stdout: options.stdout ?? lines.join("\n"),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(options.code ?? 0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }).pipe(Effect.orDie),
  });
  const layer = PhiBrowserRunner.layer;
  const run = (input = round) =>
    Effect.gen(function* () {
      const service = yield* PhiBrowserRunner.PhiBrowserRunner;
      return yield* service.run(input);
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          exists: (path) => {
            paths.push(path);
            return Effect.succeed(!options.missing);
          },
        }),
      ),
      Effect.provide(Path.layer),
      Effect.provideService(HostProcess.HomeDirectory, "/test-home"),
    );
  return { run, calls, paths };
};

describe("PhiBrowserRunner", () => {
  it.effect("runs the installed skill through a fixed stdin adapter with bounded output", () =>
    Effect.gen(function* () {
      const fixture = setup({ execute: true });
      const result = yield* fixture.run();
      expect(result).toEqual({
        result: { context: { kind: "shadow", windowId: 7 }, tabs: [] },
        context: { kind: "shadow", windowId: 7 },
      });
      expect(fixture.paths).toEqual(["/test-home/.agents/skills/phi-browser/scripts/runner.mjs"]);
      expect(fixture.calls[0]).toMatchObject({
        command: "node",
        args: fixture.paths,
        timeout: 11000,
        maxOutputBytes: 16 * 1024 * 1024,
      });
    }),
  );

  it.effect("keeps hostile-looking text literal through the transport's JSON boundary", () =>
    Effect.gen(function* () {
      const fixture = setup({ execute: true });
      const text = "' }); throw new Error('injected'); // ${process.exit(1)} ` \\n";
      const result = yield* fixture.run({ ...round, action: { operation: "type", text } });
      expect(result.result).toBe(text);
    }),
  );

  it.effect("uses an explicitly configured installed directory", () =>
    Effect.gen(function* () {
      const fixture = setup({ execute: true });
      yield* fixture.run({ ...round, skillDirectory: "/custom/phi" });
      expect(fixture.paths).toEqual(["/custom/phi/scripts/runner.mjs"]);
    }),
  );

  it.effect("fails actionably for a missing skill without starting a fallback", () =>
    Effect.gen(function* () {
      const fixture = setup({ missing: true });
      const error = yield* fixture.run().pipe(Effect.flip);
      expect(error.reason).toBe("missing-skill");
      expect(fixture.calls).toHaveLength(0);
    }),
  );

  it.effect("preserves a human-control refusal as a control error", () =>
    Effect.gen(function* () {
      const fixture = setup({
        stdout: '{"t3Phi":{"result":null,"context":null,"failure":"human-control"}}',
      });
      const error = yield* fixture.run().pipe(Effect.flip);
      expect(error.reason).toBe("human-control");
      expect(error.message).toContain("hand-back");
    }),
  );

  it.effect("allows connection setup in addition to the helper's navigation deadline", () =>
    Effect.gen(function* () {
      const fixture = setup({ stdout: '{"t3Phi":{"result":{},"context":null}}' });
      yield* fixture.run({
        ...round,
        action: { operation: "navigate", url: "https://example.com", timeout: 2 },
      });
      expect(fixture.calls[0]?.timeout).toBe(12000);
    }),
  );

  it.effect("keeps reachability probes within their own watchdog budget", () =>
    Effect.gen(function* () {
      const fixture = setup({ execute: true });
      yield* fixture.run({ ...round, probe: true, timeoutMs: 250 });
      expect(fixture.calls[0]?.timeout).toBe(250);
    }),
  );

  it.effect("does not accept a failed runner's payload or expose its stderr", () =>
    Effect.gen(function* () {
      const fixture = setup({ code: 1, stdout: '{"t3Phi":{"result":"bad","context":null}}' });
      const error = yield* fixture.run().pipe(Effect.flip);
      expect(error.reason).toBe("connection-failed");
      expect(error.message).not.toContain("bad");
    }),
  );

  it.effect("rejects malformed, missing or duplicate adapter responses", () =>
    Effect.gen(function* () {
      for (const stdout of [
        "not JSON",
        '{"t3Phi":null}',
        '{"t3Phi":{"result":1,"context":null}}\n{"t3Phi":{"result":2,"context":null}}',
      ]) {
        const error = yield* setup({ stdout }).run().pipe(Effect.flip);
        expect(error.reason).toBe("invalid-response");
      }
    }),
  );
  it.effect(
    "uses the installed default for empty settings and expands a home-relative directory",
    () =>
      Effect.gen(function* () {
        for (const directory of ["", "  ", "~/.agents/skills/phi-browser"]) {
          const fixture = setup({ execute: true });
          yield* fixture.run({ ...round, skillDirectory: directory });
          expect(fixture.paths).toEqual([
            "/test-home/.agents/skills/phi-browser/scripts/runner.mjs",
          ]);
        }
      }),
  );
});
