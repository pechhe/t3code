import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { cancelResult, landResult, make, SlipJayLandings } from "./SlipJayLandings.ts";

interface Land {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const output = (result: Land) => ({
  stdout: result.stdout,
  stderr: result.stderr,
  code: ChildProcessSpawner.ExitCode(result.code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const ROOT = "/repo/.slipjay/workspaces/t3-24";

/**
 * A SlipJay workspace whose `slipjay land` signals `started`, then finishes with
 * `result` once `release` completes. `resolvedTwice` completes when a second request
 * has resolved the workspace root.
 */
const landingHost = (result: Land) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const resolvedTwice = yield* Deferred.make<void>();
    const rootReads = yield* Ref.make(0);
    const runs = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
    const registry = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      detect: () =>
        Ref.updateAndGet(rootReads, (count) => count + 1).pipe(
          Effect.tap((count) =>
            count === 2 ? Deferred.succeed(resolvedTwice, undefined) : Effect.void,
          ),
          Effect.as({ repository: { kind: "jj", rootPath: ROOT } } as never),
        ),
    });
    const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) => {
        if (input.command === "slipjay" && input.args[0] === "land")
          return Ref.update(runs, (cwds) => [...cwds, input.cwd]).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as(output(result)),
          );
        if (input.command === "slipjay" && input.args[0] === "runner")
          return Effect.succeed(
            output({ stdout: JSON.stringify(FAILED_OUTCOME), stderr: "", code: 0 }),
          );
        return Effect.die(`unexpected ${input.command} ${input.args.join(" ")}`);
      },
    });
    const layer = Layer.effect(SlipJayLandings, make).pipe(
      Layer.provide(runner),
      Layer.provide(registry),
      Layer.provide(NodeServices.layer),
    );
    return { started, release, resolvedTwice, runs, layer };
  });

// `slipjay land`'s stderr from a real landing (t3-45, 2026-10-15).
const LANDED_STDERR = [
  "[runner slipjay-test] paused (position 1)",
  "[runner slipjay-test] connection lost; reconnecting",
  "[runner slipjay-test] fetching",
  "[runner slipjay-test] rebasing",
  "[runner slipjay-test] installing",
  "[runner slipjay-test] verifying",
  "[runner slipjay-test] integrating",
  "[runner slipjay-test] finalizing",
  "[runner slipjay-test] publishing",
  "Kept landed workspace t3-45: in use by a live process: pid 25736 (tail), pid 78172 (2.1.300)",
  "[land] paused 181.4s · fetching 5.2s · rebasing 0.7s · installing 5.8s · verifying 57.0s · integrating 0.6s · finalizing 0.2s · publishing 6.5s · housekeeping 4.0s · total 271.9s",
].join("\n");

const FAILED_OUTCOME = {
  version: 1,
  operationId: "op_a",
  status: "failed",
  stage: "verifying",
  terminal: true,
  failure: { stage: "verifying", reason: "2 tests failed" },
};

describe("landResult", () => {
  it("reports the published commit and the workspace SlipJay kept", () => {
    assert.deepStrictEqual(
      landResult(
        {
          stdout: JSON.stringify({
            ok: true,
            verdict: "landed",
            log: "slipjay runner log op_00mv9x0xe7_b1e30b9bdc77527be658cbf9",
            outcome: {
              version: 1,
              operationId: "op_00mv9x0xe7_b1e30b9bdc77527be658cbf9",
              status: "landed",
              stage: "publishing",
              terminal: true,
              publication: { state: "published", commitId: "7bedaad91c943e9a" },
            },
          }),
          stderr: LANDED_STDERR,
        },
        undefined,
      ),
      {
        landed: true,
        verdict: "landed",
        operationId: "op_00mv9x0xe7_b1e30b9bdc77527be658cbf9",
        commitId: "7bedaad91c943e9a",
        messages: [
          "Kept landed workspace t3-45: in use by a live process: pid 25736 (tail), pid 78172 (2.1.300)",
        ],
      },
    );
  });

  it("takes a failure from the runner outcome, not the gate output", () => {
    assert.deepStrictEqual(
      landResult(
        {
          stdout: JSON.stringify({
            ok: false,
            verdict: "failed",
            outcome: { operationId: "op_a", status: "failed" },
          }),
          stderr: [
            "[runner r] verifying",
            "[runner r] failed at verifying: printed text the result ignores",
            "FAIL src/a.test.ts > adds",
          ].join("\n"),
        },
        FAILED_OUTCOME,
      ),
      {
        landed: false,
        verdict: "failed",
        operationId: "op_a",
        commitId: null,
        messages: ["failed at verifying: 2 tests failed"],
      },
    );
  });

  it("still says why a landing did not publish without a failure to quote", () => {
    const declined = { ok: false, verdict: "declined", outcome: { operationId: "op_d" } };
    const stdout = JSON.stringify(declined);
    assert.deepStrictEqual(
      landResult({ stdout, stderr: "" }, { status: "declined", stage: "queued", terminal: true })
        .messages,
      ["declined at queued"],
    );
    // The outcome could not be read.
    assert.deepStrictEqual(landResult({ stdout, stderr: "" }, undefined).messages, [
      "SlipJay did not land this change (declined).",
    ]);
  });

  it("does not count an older commit's landing as this workspace's", () => {
    const result = landResult(
      { stdout: JSON.stringify({ ok: false, verdict: "landed" }), stderr: "" },
      undefined,
    );
    assert.strictEqual(result.landed, false);
    assert.deepStrictEqual(result.messages, [
      "SlipJay followed an older commit; land again to publish the current one.",
    ]);
  });

  it("reports a refusal before submission with SlipJay's message", () => {
    assert.deepStrictEqual(
      landResult(
        { stdout: "", stderr: "Nothing to land: abc123 is already on t3peach\n" },
        undefined,
      ),
      {
        landed: false,
        verdict: null,
        operationId: null,
        commitId: null,
        messages: ["Nothing to land: abc123 is already on t3peach"],
      },
    );
  });
});

describe("SlipJayLandings.land", () => {
  it.effect("lands from the workspace root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* landingHost({
          stdout: JSON.stringify({ ok: true, verdict: "landed" }),
          stderr: "",
          code: 0,
        });
        yield* Deferred.succeed(host.release, undefined);
        const result = yield* Effect.flatMap(SlipJayLandings, (landings) =>
          landings.land({ cwd: `${ROOT}/apps` }),
        ).pipe(Effect.provide(host.layer));
        assert.strictEqual(result.landed, true);
        assert.deepStrictEqual(yield* Ref.get(host.runs), [ROOT]);
      }),
    ),
  );

  it.effect("keeps landing when the caller stops waiting, and joins a second request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* landingHost({
          stdout: JSON.stringify({
            ok: false,
            verdict: "failed",
            outcome: { operationId: "op_a", status: "failed" },
          }),
          stderr: "[runner r] failed at verifying: gate failed",
          code: 1,
        });
        const result = yield* Effect.gen(function* () {
          const landings = yield* SlipJayLandings;
          const first = yield* Effect.forkChild(landings.land({ cwd: ROOT }));
          yield* Deferred.await(host.started);
          yield* Fiber.interrupt(first);
          const second = yield* Effect.forkChild(landings.land({ cwd: `${ROOT}/` }));
          yield* Deferred.await(host.resolvedTwice);
          // The second request is runnable and registers without suspending; one turn of
          // the scheduler lets it reach its wait before the landing finishes.
          yield* Effect.yieldNow;
          yield* Deferred.succeed(host.release, undefined);
          return yield* Fiber.join(second);
        }).pipe(Effect.provide(host.layer));
        assert.strictEqual((yield* Ref.get(host.runs)).length, 1);
        assert.deepStrictEqual(result.messages, ["failed at verifying: 2 tests failed"]);
      }),
    ),
  );
});

describe("SlipJayLandings.cancel", () => {
  it("tells the runner's refusal of a started operation from a failure", () => {
    assert.deepStrictEqual(cancelResult({ stdout: '{"operation":{}}', code: 0 }), {
      cancelled: true,
    });
    assert.deepStrictEqual(
      cancelResult({ stdout: '{"operation":{"id":"op_a","status":"running"}}\n', code: 1 }),
      { cancelled: false },
    );
    assert.strictEqual(
      cancelResult({ stdout: '{"error":"Unknown operation"}', code: 1 }),
      undefined,
    );
    assert.strictEqual(cancelResult({ stdout: "", code: 1 }), undefined);
  });

  it.effect("refuses an operation it does not show queued, without asking the runner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* landingHost({ stdout: "", stderr: "", code: 0 });
        const error = yield* Effect.flatMap(SlipJayLandings, (landings) =>
          landings.cancel({ operationId: "op_unknown" }),
        ).pipe(Effect.provide(host.layer), Effect.flip);
        assert.strictEqual(error._tag, "SlipJayCommandError");
        assert.strictEqual(error.detail, "This operation is no longer queued.");
      }),
    ),
  );
});

describe("SlipJayLandings.readLog", () => {
  it.effect("reads a removed workspace's own landing log, and no other operation", () =>
    Effect.gen(function* () {
      const removed = "/nonexistent/.slipjay/workspaces/sl-spare-152cb3";
      const logReads = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
      const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) => {
          if (input.args[0] === "landed")
            return Effect.succeed(
              output({
                stdout: JSON.stringify({ artifactCommitId: "abc1234", operationId: "op_landed" }),
                stderr: "",
                code: 0,
              }),
            );
          if (input.args[0] === "runner" && input.args[1] === "log")
            return Ref.update(logReads, (cwds) => [...cwds, input.cwd]).pipe(
              Effect.as(output({ stdout: "gate passed\n", stderr: "", code: 0 })),
            );
          return Effect.die(`unexpected ${input.command} ${input.args.join(" ")}`);
        },
      });
      const layer = Layer.effect(SlipJayLandings, make).pipe(
        Layer.provide(runner),
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({ detect: () => Effect.succeed(null) }),
        ),
        Layer.provide(NodeServices.layer),
      );

      const [log, other] = yield* Effect.gen(function* () {
        const landings = yield* SlipJayLandings;
        return [
          yield* landings.readLog({ cwd: removed, operationId: "op_landed" }),
          yield* landings.readLog({ cwd: removed, operationId: "op_other" }).pipe(Effect.flip),
        ] as const;
      }).pipe(Effect.provide(layer));

      assert.deepStrictEqual(log, { log: "gate passed\n", truncated: false });
      // The runner holds the log, so it is read without the missing checkout.
      assert.deepStrictEqual(yield* Ref.get(logReads), [undefined]);
      assert.strictEqual(other.detail, "This landing is not tracked for this workspace.");
    }),
  );
});

describe("SlipJay failures", () => {
  const removed = "/nonexistent/.slipjay/workspaces/t3-51";
  const spawnFailure = new ProcessRunner.ProcessSpawnError({
    command: "slipjay",
    argumentCount: 1,
    cause: new Error("spawn slipjay ENOENT"),
  });
  const failingHost = (logExit: Land) =>
    Layer.effect(SlipJayLandings, make).pipe(
      Layer.provide(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) => {
            if (input.args[0] === "landed")
              return Effect.succeed(
                output({
                  stdout: JSON.stringify({ artifactCommitId: "abc1234", operationId: "op_landed" }),
                  stderr: "",
                  code: 0,
                }),
              );
            if (input.args[0] === "runner") return Effect.succeed(output(logExit));
            if (input.args[0] === "land") return Effect.fail(spawnFailure);
            return Effect.die(`unexpected ${input.command} ${input.args.join(" ")}`);
          },
        }),
      ),
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: ({ cwd }) =>
            Effect.succeed(
              cwd === removed ? null : ({ repository: { kind: "jj", rootPath: ROOT } } as never),
            ),
        }),
      ),
      Layer.provide(NodeServices.layer),
    );

  it.effect("a failed runner log read says so without SlipJay's output", () =>
    Effect.gen(function* () {
      const stderr =
        "error: GET https://runner.internal/v1/operations/op_landed/log?token=secret 500";
      const error = yield* Effect.flatMap(SlipJayLandings, (landings) =>
        landings.readLog({ cwd: removed, operationId: "op_landed" }),
      ).pipe(Effect.flip, Effect.provide(failingHost({ stdout: "", stderr, code: 2 })));

      assert.strictEqual(error._tag, "SlipJayCommandError");
      assert.strictEqual(error.exitCode, 2);
      assert.include(error.message, "SlipJay could not read the landing log.");
      assert.notInclude(JSON.stringify(error), "runner.internal");
    }),
  );

  it.effect("a land that cannot be spawned keeps the spawn failure as its cause", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flatMap(SlipJayLandings, (landings) =>
        landings.land({ cwd: ROOT }),
      ).pipe(Effect.flip, Effect.provide(failingHost({ stdout: "", stderr: "", code: 0 })));

      assert.strictEqual(error.message, "SlipJay could not be run to land this workspace.");
      assert.strictEqual(error.cause, spawnFailure);
    }),
  );
});
