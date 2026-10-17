import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as SlipJayLandings from "./SlipJayLandings.ts";
import {
  machineSettings,
  make,
  policySetLine,
  policySetResult,
  projectSettings,
  SlipJaySettings,
} from "./SlipJaySettings.ts";

// Trimmed from `slipjay policy show --json` and `slipjay config --json` in pechhe/splay (2026-10-17).
const POLICY = {
  integrationBranch: "main",
  revision: "06e82718951f8cd725b1da410fbc247257ce14d9",
  digest: "sha256:3686",
  declared: {
    version: 1,
    integrationBranch: "main",
    spares: 8,
    generatedPaths: [".build", "build"],
    process: "light",
    parallelExecution: true,
  },
  settings: {
    spares: 8,
    process: "light",
    requiredLandingVerification: [
      { executable: "node", args: ["--check", "BrowserExtension/background.js"] },
    ],
  },
  retired: ["parallelExecution"],
};
const CONFIG = (repository: string, machineLimit: number | null) => ({
  path: "/Users/me/.slipjay/config.json",
  runner: {
    value: "ssh://peach-box",
    source: "file",
    file: "ssh://peach-box",
    overriddenByEnvironment: false,
  },
  spares: [
    {
      repository,
      declared: 8,
      machineLimit,
      effective: machineLimit ?? 8,
      source: { integrationBranch: "main", commitId: POLICY.revision },
    },
  ],
});

describe("SlipJay settings output", () => {
  it("reads a project's shared policy with this machine's spares, filling defaults", () => {
    const settings = projectSettings(
      JSON.stringify(POLICY),
      JSON.stringify(CONFIG("/repo/splay", 2)),
      "/repo/splay",
    );
    assert.deepStrictEqual(settings, {
      integrationBranch: "main",
      revision: POLICY.revision,
      spares: 8,
      process: "light",
      requiredLandingVerification: [
        { executable: "node", args: ["--check", "BrowserExtension/background.js"] },
      ],
      releaseBranch: null,
      sharedPaths: [],
      generatedPaths: [".build", "build"],
      tracker: "github",
      machineSpares: { machineLimit: 2, effective: 2 },
    });
  });

  it("falls back to the declared spares when the machine reports another repository", () => {
    const settings = projectSettings(
      JSON.stringify(POLICY),
      JSON.stringify(CONFIG("/repo/other", 1)),
      "/repo/splay",
    );
    assert.deepStrictEqual(settings?.machineSpares, { machineLimit: null, effective: 8 });
  });

  it("reads nothing from output it does not recognise", () => {
    assert.strictEqual(
      projectSettings("not json", JSON.stringify(CONFIG("/r", null)), "/r"),
      undefined,
    );
    assert.strictEqual(machineSettings("Usage: slipjay"), undefined);
    assert.strictEqual(policySetResult(""), undefined);
  });

  it("reads the runner and a policy outcome", () => {
    assert.deepStrictEqual(machineSettings(JSON.stringify(CONFIG("/r", null))), {
      available: true,
      runner: "ssh://peach-box",
      runnerInFile: "ssh://peach-box",
      overriddenByEnvironment: false,
    });
    assert.deepStrictEqual(
      policySetResult(JSON.stringify({ ok: false, phase: "refused", reason: "Stale base" })),
      { phase: "refused", revision: null, reason: "Stale base" },
    );
  });

  it("reads `--json-lines` progress, and older SlipJay's refusal of it", () => {
    assert.deepStrictEqual(policySetLine('{"phase":"following","operationId":"op_7"}'), {
      phase: "following",
      operationId: "op_7",
    });
    assert.deepStrictEqual(
      policySetResult(
        '{"phase":"following","operationId":"op_7"}\n{"ok":true,"phase":"landed","operationId":"op_7","revision":"abc"}\n',
      ),
      { phase: "landed", revision: "abc", reason: null },
    );
    assert.deepStrictEqual(
      policySetResult(
        JSON.stringify(
          { ok: false, phase: "refused", reason: "Usage: slipjay policy show" },
          null,
          2,
        ),
      ),
      {
        phase: "refused",
        revision: null,
        reason: "Saving here needs SlipJay 3.27.0 or later on this machine.",
      },
    );
  });
});

const output = (stdout: string, code = 0) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

describe("SlipJaySettings", () => {
  it.effect(
    "lands only the changed fields from the read revision, and follows a runner change",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // An in-memory SlipJay project, so finding it never waits on the disk and a
          // second save registers before the first can finish.
          const root = "/repo/splay";
          const files = FileSystem.layerNoop({
            exists: (target) =>
              Effect.succeed(target === `${root}/.jj` || target === `${root}/slipjay.json`),
            readFileString: () => Effect.succeed(JSON.stringify({ integrationBranch: "main" })),
            realPath: (target) => Effect.succeed(target),
          });
          const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
          const followed = yield* Ref.make(0);
          // The runner holds the landing until the test lets it finish.
          const landing = yield* Deferred.make<void>();
          const following = '{"phase":"following","operationId":"op_7"}\n';
          const landed = JSON.stringify({ ok: true, phase: "landed", revision: "f".repeat(40) });
          const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
            run: (input) =>
              Ref.update(calls, (all) => [...all, input.args]).pipe(
                Effect.andThen(() => {
                  if (input.command !== "slipjay") return Effect.succeed(output("", 1));
                  if (input.args[0] === "policy" && input.args[1] === "set") {
                    input.onStdoutChunk?.(new TextEncoder().encode(following));
                    return Deferred.await(landing).pipe(
                      Effect.as(output(`${following}${landed}\n`)),
                    );
                  }
                  return Effect.succeed(
                    input.args[0] === "config" && input.args[1] === "--json"
                      ? output(JSON.stringify(CONFIG(root, null)))
                      : output(""),
                  );
                }),
              ),
          });
          const landings = Layer.effect(
            SlipJayLandings.SlipJayLandings,
            Effect.map(SlipJayLandings.SlipJayLandings, (none) =>
              SlipJayLandings.SlipJayLandings.of({
                ...none,
                followRunnerChange: Ref.update(followed, (count) => count + 1),
              }),
            ),
          ).pipe(Layer.provide(SlipJayLandings.layerNone));
          const layer = Layer.effect(SlipJaySettings, make).pipe(
            Layer.provide(runner),
            Layer.provide(landings),
            Layer.provide(files),
            Layer.provide(NodeServices.layer),
          );
          const change = { cwd: root, base: "a".repeat(40), process: "light" } as const;
          const { first, outcome, machine } = yield* Effect.gen(function* () {
            const settings = yield* SlipJaySettings;
            const first = yield* settings.setPolicy(change);
            // Asking again while it lands joins the same run for its outcome.
            const waiting = yield* Effect.forkChild(settings.setPolicy(change), {
              startImmediately: true,
            });
            yield* Deferred.succeed(landing, undefined);
            const outcome = yield* Fiber.join(waiting);
            const machine = yield* settings.setRunner({ location: "http://127.0.0.1:7787" });
            return { first, outcome, machine };
          }).pipe(Effect.provide(layer));
          assert.deepStrictEqual(first, { phase: "following", operationId: "op_7" });
          assert.deepStrictEqual(outcome, {
            phase: "landed",
            revision: "f".repeat(40),
            reason: null,
          });
          assert.strictEqual(machine.runner, "ssh://peach-box");
          const slipjay = (yield* Ref.get(calls)).filter((args) => args[0] !== "git");
          assert.strictEqual(
            slipjay.filter((args) => args[1] === "set" && args[0] === "policy").length,
            1,
          );
          assert.deepStrictEqual(
            slipjay.find((args) => args[1] === "set" && args[0] === "policy"),
            [
              "policy",
              "set",
              "--json-lines",
              "--base",
              "a".repeat(40),
              "--patch",
              JSON.stringify({ process: "light" }),
            ],
          );
          assert.ok(
            slipjay.some((args) => args.join(" ") === "config set runner http://127.0.0.1:7787"),
          );
          assert.strictEqual(yield* Ref.get(followed), 1);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a directory that is not a SlipJay project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () => Effect.succeed(output("", 1)),
        });
        const layer = Layer.effect(SlipJaySettings, make).pipe(
          Layer.provide(runner),
          Layer.provide(SlipJayLandings.layerNone),
          Layer.provide(NodeServices.layer),
        );
        const error = yield* Effect.flatMap(SlipJaySettings, (settings) =>
          settings.setSpareLimit({ cwd: root, limit: 0 }),
        ).pipe(Effect.provide(layer), Effect.flip);
        assert.strictEqual(error.detail, "This is not a SlipJay project.");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
