import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";
import { collectReading, parseReading } from "./metricCollection.ts";

it.each([
  ["42\n", { value: 42, revision: null, evidence: "42" }],
  ["-0.5", { value: -0.5, revision: null, evidence: "-0.5" }],
  [
    '{"value":3,"revision":"abc","evidence":"three files"}',
    { value: 3, revision: "abc", evidence: "three files" },
  ],
  ['{"value":3}', { value: 3, revision: null, evidence: '{"value":3}' }],
  ["", null],
  ["12 files", null],
  ["NaN", null],
  ['{"value":"3"}', null],
  ["[1]", null],
])("reads %j as %j", (stdout, expected) => {
  assert.deepEqual(parseReading(stdout), expected);
});

it.effect("records a command that outlives its time limit as a failed reading with no value", () =>
  Effect.gen(function* () {
    const reading = yield* collectReading(
      {
        run: (input) =>
          Effect.fail(
            new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: 30_000,
            }),
          ),
      },
      ["slow"],
      "/project",
    );
    assert.isNull(reading.value);
    assert.include(reading.evidence, "did not finish within 30 seconds");
  }),
);
