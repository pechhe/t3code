import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { SLIPJAY_PROJECT_FILE_NAME } from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import { make, SlipJayGuard } from "./SlipJayGuard.ts";

const output = (stdout: string, code: number) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const denyHook = (reason: string) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });

/** A guard host whose `slipjay` always answers the same way, recording every call. */
const host = () => {
  const calls: Array<ProcessRunner.ProcessRunInput> = [];
  const answer = { stdout: "", code: 0 };
  const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (input: ProcessRunner.ProcessRunInput) => {
      calls.push(input);
      return Effect.succeed(output(answer.stdout, answer.code));
    },
  });
  const layer = Layer.effect(SlipJayGuard, make).pipe(
    Layer.provide(runner),
    Layer.provideMerge(NodeServices.layer),
  );
  return { calls, answer, layer };
};

/** A fresh temporary workspace; `governed` makes it one SlipJay would allocate and guard. */
const workspace = (governed: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-guard-" });
    if (governed) {
      yield* fs.makeDirectory(`${root}/.jj`);
      yield* fs.writeFileString(`${root}/${SLIPJAY_PROJECT_FILE_NAME}`, "{}");
    }
    return root;
  });

const withGuard = <A, E>(
  program: Effect.Effect<A, E, SlipJayGuard | FileSystem.FileSystem | Scope.Scope>,
  fixture: ReturnType<typeof host>,
) => Effect.scoped(program).pipe(Effect.provide(fixture.layer));

describe("SlipJayGuard", () => {
  it.effect("asks the guard with the hook JSON it already reads", () => {
    const fixture = host();
    return withGuard(
      Effect.gen(function* () {
        const root = yield* workspace(true);
        const guard = yield* SlipJayGuard;

        const decision = yield* guard.check({ cwd: root, command: "git push origin main" });

        assert.deepStrictEqual(decision, { allowed: true, reason: null });
        assert.strictEqual(fixture.calls.length, 1);
        assert.strictEqual(fixture.calls[0]?.command, "slipjay");
        assert.deepStrictEqual(fixture.calls[0]?.args, ["guard"]);
        assert.deepStrictEqual(JSON.parse(fixture.calls[0]?.stdin ?? "null"), {
          tool_name: "Bash",
          tool_input: { command: "git push origin main" },
          cwd: root,
        });
      }),
      fixture,
    );
  });

  it.effect("blocks a denied command with the guard's own message", () => {
    const fixture = host();
    fixture.answer.stdout = denyHook("Use `slipjay land` instead.");
    return withGuard(
      Effect.gen(function* () {
        const root = yield* workspace(true);
        const guard = yield* SlipJayGuard;

        const decision = yield* guard.check({ cwd: root, command: "git push origin main" });

        assert.deepStrictEqual(decision, {
          allowed: false,
          reason: "Use `slipjay land` instead.",
        });
      }),
      fixture,
    );
  });

  it.effect("runs nothing outside a SlipJay repository", () => {
    const fixture = host();
    return withGuard(
      Effect.gen(function* () {
        const root = yield* workspace(false);
        const guard = yield* SlipJayGuard;

        const decision = yield* guard.check({ cwd: root, command: "git push origin main" });

        assert.deepStrictEqual(decision, { allowed: true, reason: null });
        assert.deepStrictEqual(
          fixture.calls.map((c) => [c.command, c.args]),
          [],
        );
      }),
      fixture,
    );
  });

  it.effect("serves a repeated command from its answer cache", () => {
    const fixture = host();
    fixture.answer.stdout = denyHook("Blocked.");
    return withGuard(
      Effect.gen(function* () {
        const root = yield* workspace(true);
        const guard = yield* SlipJayGuard;
        const check = guard.check({ cwd: root, command: "git push origin main" });

        const first = yield* check;
        const second = yield* check;

        assert.deepStrictEqual(first, second);
        assert.strictEqual(first.allowed, false);
        assert.strictEqual(fixture.calls.length, 1);
      }),
      fixture,
    );
  });

  // A jj verdict depends on the working copy: a cached denial would refuse the retry an
  // agent earned by describing its commit, and a cached allow would let the next one
  // abandon work it has since written.
  it.effect("asks again for a repeated jj command", () => {
    const fixture = host();
    fixture.answer.stdout = denyHook("Describe @ before moving.");
    return withGuard(
      Effect.gen(function* () {
        const root = yield* workspace(true);
        const guard = yield* SlipJayGuard;
        const check = guard.check({ cwd: root, command: "jj new" });

        const first = yield* check;
        fixture.answer.stdout = "";
        const second = yield* check;

        assert.strictEqual(first.allowed, false);
        assert.deepStrictEqual(second, { allowed: true, reason: null });
        assert.strictEqual(fixture.calls.length, 2);
      }),
      fixture,
    );
  });

  it.effect("asks again for a jj command anywhere in a shell line", () => {
    const fixture = host();
    fixture.answer.stdout = denyHook("Refusing to abandon work.");
    return withGuard(
      Effect.gen(function* () {
        const root = yield* workspace(true);
        const guard = yield* SlipJayGuard;
        for (const command of [
          "cd sub && jj abandon",
          "FOO=1 jj new",
          "jj\tabandon",
          "true | jj abandon",
          "/usr/bin/jj new",
          "./jj abandon",
          "jj;",
        ]) {
          yield* guard.check({ cwd: root, command });
          yield* guard.check({ cwd: root, command });
        }
        assert.strictEqual(fixture.calls.length, 14);
      }),
      fixture,
    );
  });

  it.effect("reports whether the guard would judge a directory at all", () => {
    const fixture = host();
    return withGuard(
      Effect.gen(function* () {
        const governed = yield* workspace(true);
        const ungoverned = yield* workspace(false);
        const guard = yield* SlipJayGuard;

        assert.isTrue(yield* guard.governs(governed));
        assert.isFalse(yield* guard.governs(ungoverned));
        assert.strictEqual(fixture.calls.length, 0);
      }),
      fixture,
    );
  });

  it.effect("allows the call when the guard cannot run", () => {
    const fixture = host();
    fixture.answer.code = 127;
    return withGuard(
      Effect.gen(function* () {
        const root = yield* workspace(true);
        const guard = yield* SlipJayGuard;

        const decision = yield* guard.check({ cwd: root, command: "git push origin main" });

        assert.deepStrictEqual(decision, { allowed: true, reason: null });
      }),
      fixture,
    );
  });
});
