import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { make, promoteResult, promotionPlan, SlipJayReleases } from "./SlipJayReleases.ts";

// Trimmed from `slipjay promote` in pechhe/yardsmith (2026-10-16).
const PLANNED = {
  ok: true,
  status: "planned",
  integrationBranch: "develop",
  releaseBranch: "master",
  remote: "origin",
  base: "646628156b603588375460d07029cfe86f21a83c",
  candidate: "bf787f66d9f5d935414ae73416018382f985c9fb",
  commits: 14,
  paths: ["GLOSSARY.md"],
  migrationArtifacts: [
    "apps/planner-workbench/drizzle/0321_concerned_the_enforcers.sql",
    "apps/planner-workbench/drizzle/0322_clear_tony_stark.sql",
  ],
  nonAdditiveMigrations: ["apps/planner-workbench/drizzle/0321_concerned_the_enforcers.sql"],
  checks: ["bun run verify:release"],
  halfBuiltSpecs: {
    checked: true,
    specs: [
      {
        number: 2478,
        title: "Agents act in HQ as themselves",
        url: "https://github.com/pechhe/yardsmith/issues/2478",
        closedTickets: 2,
        totalTickets: 5,
        summary: "#2478 Agents act in HQ as themselves: 2 of 5 Tickets closed",
      },
    ],
  },
  subjects: ["One HQ notification path (#2335)"],
  next: "After explicit human approval: slipjay promote --confirm bf787f66d9f5.",
};

describe("promotionPlan", () => {
  it("reads the candidate, its migrations and the Specs it only partly delivers", () => {
    const plan = promotionPlan(JSON.stringify(PLANNED, null, 2));
    expect(plan?.candidate).toBe(PLANNED.candidate);
    expect(plan?.nonAdditiveMigrations).toEqual(PLANNED.nonAdditiveMigrations);
    expect(plan?.halfBuiltSpecs.map((spec) => [spec.number, spec.closedTickets])).toEqual([
      [2478, 2],
    ]);
    expect(plan?.subjects).toEqual(PLANNED.subjects);
  });

  it("reads a refusal, which carries no candidate", () => {
    expect(
      promotionPlan(JSON.stringify({ ok: false, status: "refused", reason: "No releaseBranch" })),
    ).toEqual({
      status: "refused",
      reason: "No releaseBranch",
      subjects: [],
      checks: [],
      migrationArtifacts: [],
      nonAdditiveMigrations: [],
      halfBuiltSpecs: [],
    });
  });

  it("has no plan when SlipJay printed none", () => {
    expect(promotionPlan("")).toBeUndefined();
  });
});

describe("promoteResult", () => {
  it("has released only once production deployed the candidate", () => {
    expect(
      promoteResult({
        stdout: JSON.stringify({
          ok: true,
          status: "released",
          production: { status: "deployed" },
        }),
        stderr: "",
      }),
    ).toEqual({ released: true, status: "released", messages: ["Production deployed"] });
    expect(
      promoteResult({
        stdout: JSON.stringify({
          ok: true,
          status: "released",
          production: { status: "failed", reason: "deploy failed: hq (health check)" },
        }),
        stderr: "",
      }).released,
    ).toBe(false);
  });

  it("reports a failed release check in SlipJay's words", () => {
    expect(
      promoteResult({
        stdout: JSON.stringify({
          ok: false,
          status: "failed",
          stage: "verifying",
          reason: "2 tests failed",
        }),
        stderr: "[runner] release failed at verifying: 2 tests failed",
      }),
    ).toEqual({ released: false, status: "failed", messages: ["2 tests failed"] });
  });

  it("reports SlipJay's own refusal when it printed no result", () => {
    expect(
      promoteResult({ stdout: "", stderr: "fetching\nError: candidate is not staging's commit\n" }),
    ).toEqual({
      released: false,
      status: "refused",
      messages: ["Error: candidate is not staging's commit"],
    });
  });
});

const CANDIDATE_A = "bf787f66d9f5d935414ae73416018382f985c9fb";
const CANDIDATE_B = "a9278f16fee23eafee7f14e724e852db7968f26f";

describe("SlipJayReleases.promote", () => {
  it.effect(
    "joins a second request for the same candidate and refuses a different one while it runs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped();
          yield* fs.makeDirectory(path.join(root, ".jj"));
          yield* fs.writeFileString(
            path.join(root, "slipjay.json"),
            JSON.stringify({ integrationBranch: "develop", releaseBranch: "master" }),
          );
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const confirms = yield* Ref.make<ReadonlyArray<string>>([]);
          // The third read of slipjay.json is the second request for the same candidate
          // resolving the project, just before it registers.
          const projectReads = yield* Ref.make(0);
          const thirdRead = yield* Deferred.make<void>();
          const files = Layer.effect(
            FileSystem.FileSystem,
            Effect.map(FileSystem.FileSystem, (real) => ({
              ...real,
              readFileString: (target: string, encoding?: string) =>
                real
                  .readFileString(target, encoding)
                  .pipe(
                    Effect.tap(() =>
                      Ref.updateAndGet(projectReads, (count) => count + 1).pipe(
                        Effect.flatMap((count) =>
                          count === 3 ? Deferred.succeed(thirdRead, undefined) : Effect.void,
                        ),
                      ),
                    ),
                  ),
            })),
          ).pipe(Layer.provide(NodeServices.layer));
          const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
            run: (input) =>
              input.command === "slipjay" && input.args[1] === "--confirm"
                ? Ref.update(confirms, (all) => [...all, input.args[2] ?? ""]).pipe(
                    Effect.andThen(Deferred.succeed(started, undefined)),
                    Effect.andThen(Deferred.await(release)),
                    Effect.as({
                      stdout: JSON.stringify({
                        ok: true,
                        status: "released",
                        production: { status: "deployed" },
                      }),
                      stderr: "",
                      code: ChildProcessSpawner.ExitCode(0),
                      timedOut: false,
                      stdoutTruncated: false,
                      stderrTruncated: false,
                      stdoutInvalidUtf8: false,
                      stderrInvalidUtf8: false,
                    }),
                  )
                : Effect.die(`unexpected ${input.command} ${input.args.join(" ")}`),
          });
          const layer = Layer.effect(SlipJayReleases, make).pipe(
            Layer.provide(runner),
            Layer.provide(files),
            Layer.provide(NodeServices.layer),
          );
          const results = yield* Effect.gen(function* () {
            const releases = yield* SlipJayReleases;
            const first = yield* Effect.forkChild(
              releases.promote({ cwd: root, candidate: CANDIDATE_A }),
            );
            yield* Deferred.await(started);
            const other = yield* releases
              .promote({ cwd: root, candidate: CANDIDATE_B })
              .pipe(Effect.flip);
            const second = yield* Effect.forkChild(
              releases.promote({ cwd: root, candidate: CANDIDATE_A }),
            );
            yield* Deferred.await(thirdRead);
            // Registering follows the read without suspending; one scheduler turn reaches it.
            yield* Effect.yieldNow;
            yield* Deferred.succeed(release, undefined);
            return { other, first: yield* Fiber.join(first), second: yield* Fiber.join(second) };
          }).pipe(Effect.provide(layer));
          assert.deepStrictEqual(yield* Ref.get(confirms), [CANDIDATE_A]);
          assert.strictEqual(results.first.released, true);
          assert.strictEqual(results.second.released, true);
          assert.include(results.other.detail, "bf787f66 is still running");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a directory that is not a SlipJay project, without running SlipJay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) => Effect.die(`unexpected ${input.command}`),
        });
        const error = yield* Effect.flatMap(SlipJayReleases, (releases) =>
          releases.promote({ cwd: root, candidate: CANDIDATE_A }),
        ).pipe(
          Effect.provide(
            Layer.effect(SlipJayReleases, make).pipe(
              Layer.provide(runner),
              Layer.provide(NodeServices.layer),
            ),
          ),
          Effect.flip,
        );
        assert.strictEqual(error.detail, "This is not a SlipJay project.");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
