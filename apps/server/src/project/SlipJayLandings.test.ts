import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { make, parseLandOutput, SlipJayLandings } from "./SlipJayLandings.ts";

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
    const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) => {
        if (input.command === "jj" && input.args.includes("root"))
          return Ref.updateAndGet(rootReads, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 2 ? Deferred.succeed(resolvedTwice, undefined) : Effect.void,
            ),
            Effect.as(output({ stdout: `${ROOT}\n`, stderr: "", code: 0 })),
          );
        if (input.command === "slipjay" && input.args[0] === "land")
          return Ref.update(runs, (cwds) => [...cwds, input.cwd]).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as(output(result)),
          );
        return Effect.die(`unexpected ${input.command} ${input.args.join(" ")}`);
      },
    });
    const layer = Layer.effect(SlipJayLandings, make).pipe(
      Layer.provide(runner),
      Layer.provide(NodeServices.layer),
    );
    return { started, release, resolvedTwice, runs, layer };
  });

describe("parseLandOutput", () => {
  it("keeps SlipJay's failure and workspace changes, not the gate output", () => {
    assert.deepStrictEqual(
      parseLandOutput(
        JSON.stringify({
          ok: false,
          verdict: "failed",
          outcome: { operationId: "op_a", status: "failed" },
        }),
        [
          "[runner r] queued (position 1)",
          "[runner r] verifying",
          "[runner r] failed at verifying: 2 tests failed",
          "pnpm exec vp test run",
          "FAIL src/a.test.ts > adds",
          "slipjay runner log op_a",
          "[land] queued 0.1s · verifying 59.9s · total 61.2s",
        ].join("\n"),
      ),
      {
        landed: false,
        verdict: "failed",
        operationId: "op_a",
        commitId: null,
        messages: ["[runner r] failed at verifying: 2 tests failed"],
      },
    );
  });

  it("reports the published commit and the workspace SlipJay kept", () => {
    assert.deepStrictEqual(
      parseLandOutput(
        JSON.stringify({
          ok: true,
          verdict: "landed",
          outcome: { operationId: "op_a", publication: { commitId: "6d1274008e7e" } },
        }),
        "[runner r] publishing\nKept landed workspace t3-24: in use by a live process: pid 1 (node)\n",
      ),
      {
        landed: true,
        verdict: "landed",
        operationId: "op_a",
        commitId: "6d1274008e7e",
        messages: ["Kept landed workspace t3-24: in use by a live process: pid 1 (node)"],
      },
    );
  });

  it("does not count an older commit's landing as this workspace's", () => {
    const result = parseLandOutput(
      JSON.stringify({ ok: false, verdict: "landed" }),
      "[runner r] followed an older commit (abc); land again to publish your current commit\n",
    );
    assert.strictEqual(result.landed, false);
    assert.deepStrictEqual(result.messages, [
      "[runner r] followed an older commit (abc); land again to publish your current commit",
    ]);
  });

  it("reports a refusal before submission with SlipJay's message", () => {
    assert.deepStrictEqual(parseLandOutput("", "Nothing to land: abc123 is already on t3peach\n"), {
      landed: false,
      verdict: null,
      operationId: null,
      commitId: null,
      messages: ["Nothing to land: abc123 is already on t3peach"],
    });
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
          stdout: JSON.stringify({ ok: false, verdict: "failed" }),
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
        assert.deepStrictEqual(result.messages, ["[runner r] failed at verifying: gate failed"]);
      }),
    ),
  );
});
