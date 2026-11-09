import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import type { VcsSlipJayPromotion } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../processRunner.ts";
import * as SlipJayLandings from "./SlipJayLandings.ts";
import { make, promoteResult, promotionNextStep, SlipJayReleases } from "./SlipJayReleases.ts";

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
        title: "Agents act in Weave as themselves",
        url: "https://github.com/pechhe/yardsmith/issues/2478",
        closedTickets: 2,
        totalTickets: 5,
        summary: "#2478 Agents act in Weave as themselves: 2 of 5 Tickets closed",
      },
    ],
  },
  subjects: ["One Weave notification path (#2335)"],
  verification: {
    status: "failed",
    commit: "bf787f66d9f5d935414ae73416018382f985c9fb",
    operationId: "op_1",
    failedCommand: "bun run verify:release",
  },
  next: "After explicit human approval: slipjay promote --confirm bf787f66d9f5.",
};

describe("promotionNextStep", () => {
  const plan = (over: Record<string, unknown>) => JSON.stringify({ ...PLANNED, ...over }, null, 2);

  it("confirms the planned candidate, including one whose verification is unfinished", () => {
    for (const status of ["passed", "running", "queued", "none"]) {
      expect(promotionNextStep(plan({ verification: { status } }))).toEqual({
        next: "confirm",
        candidate: PLANNED.candidate,
      });
    }
  });

  it("stops on a failed verification, naming the check", () => {
    expect(promotionNextStep(JSON.stringify(PLANNED))).toEqual({
      next: "stop",
      reason:
        "bf787f6 failed verification at bun run verify:release. A fix that lands and passes becomes the next candidate.",
    });
  });

  it("does nothing when up to date, and stops with SlipJay's reason on a refusal", () => {
    expect(promotionNextStep(plan({ status: "up_to_date" }))).toEqual({ next: "nothing" });
    expect(
      promotionNextStep(
        JSON.stringify({ ok: false, status: "refused", reason: "Audit failed last night" }),
      ),
    ).toEqual({ next: "stop", reason: "Audit failed last night" });
  });

  it("stops without leaking stderr when SlipJay printed no plan", () => {
    expect(promotionNextStep("").next).toBe("stop");
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
          production: { status: "failed", reason: "deploy failed: weave (health check)" },
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

const output = (stdout: unknown) => ({
  stdout: JSON.stringify(stdout),
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const REPO = "pechhe/yardsmith";

const nodeLayer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

const project = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(path.join(root, ".jj"));
  yield* fs.writeFileString(
    path.join(root, "slipjay.json"),
    JSON.stringify({ integrationBranch: "develop", releaseBranch: "master" }),
  );
  return root;
});

// Runner keys and remote URLs need not agree on case.
const checkoutOf = Layer.effect(
  SlipJayLandings.SlipJayLandings,
  Effect.map(SlipJayLandings.SlipJayLandings, (none) =>
    SlipJayLandings.SlipJayLandings.of({
      ...none,
      repositoryOf: () => Effect.succeed(REPO.toUpperCase()),
    }),
  ),
).pipe(Layer.provide(SlipJayLandings.layerNone));

const releasesWith = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  Layer.effect(SlipJayReleases, make).pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
    Layer.provide(checkoutOf),
    Layer.provide(nodeLayer),
  );

/** The next promotions snapshot matching `done`, for awaiting a release's milestone. */
const promotionsUntil = (done: (all: ReadonlyArray<VcsSlipJayPromotion>) => boolean) =>
  Effect.flatMap(SlipJayReleases, (releases) =>
    releases.promotions.pipe(
      Stream.filter(done),
      Stream.take(1),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    ),
  );

describe("SlipJayReleases.promote", () => {
  it.effect("plans, confirms exactly that candidate once, and leaves no promotion behind", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* project;
        const confirmed = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
          Ref.update(calls, (all) => [...all, input.args.join(" ")]).pipe(
            Effect.andThen(
              input.args[1] === "--confirm"
                ? Deferred.succeed(confirmed, undefined).pipe(
                    Effect.andThen(Deferred.await(finish)),
                    Effect.as(
                      output({
                        ok: true,
                        status: "released",
                        production: { status: "deployed" },
                      }),
                    ),
                  )
                : Effect.succeed(output({ ...PLANNED, verification: { status: "running" } })),
            ),
          );
        yield* Effect.gen(function* () {
          const releases = yield* SlipJayReleases;
          yield* releases.promote({ cwd: root, repo: REPO });
          yield* Deferred.await(confirmed);
          // A second press while it runs joins the release instead of starting another.
          yield* releases.promote({ cwd: root, repo: REPO });
          const running = yield* promotionsUntil((all) => all.length === 1);
          assert.deepStrictEqual(running, [
            { repo: REPO, status: "releasing", candidate: PLANNED.candidate, reason: null },
          ]);
          yield* Deferred.succeed(finish, undefined);
          yield* promotionsUntil((all) => all.length === 0);
        }).pipe(Effect.provide(releasesWith(run)));
        assert.deepStrictEqual(yield* Ref.get(calls), [
          "promote",
          `promote --confirm ${PLANNED.candidate}`,
        ]);
      }),
    ).pipe(Effect.provide(nodeLayer)),
  );

  it.effect("reports a refused confirm until it is dismissed, and allows another try", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* project;
        const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
          Effect.succeed(
            input.args[1] === "--confirm"
              ? output({ ok: false, status: "failed", reason: "2 tests failed" })
              : output({ ...PLANNED, verification: { status: "passed" } }),
          );
        yield* Effect.gen(function* () {
          const releases = yield* SlipJayReleases;
          yield* releases.promote({ cwd: root, repo: REPO });
          const failed = yield* promotionsUntil((all) => all[0]?.status === "failed");
          assert.deepStrictEqual(failed, [
            {
              repo: REPO,
              status: "failed",
              candidate: PLANNED.candidate,
              reason: "2 tests failed",
            },
          ]);
          yield* releases.dismiss({ repo: REPO });
          yield* promotionsUntil((all) => all.length === 0);
          yield* releases.promote({ cwd: root, repo: REPO });
          yield* promotionsUntil((all) => all[0]?.status === "failed");
        }).pipe(Effect.provide(releasesWith(run)));
      }),
    ).pipe(Effect.provide(nodeLayer)),
  );

  it.effect("never confirms a candidate that failed verification", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* project;
        const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
          input.args[1] === "--confirm"
            ? Effect.die("confirmed a failed candidate")
            : Effect.succeed(output(PLANNED));
        const failed = yield* Effect.gen(function* () {
          const releases = yield* SlipJayReleases;
          yield* releases.promote({ cwd: root, repo: REPO });
          return yield* promotionsUntil((all) => all[0]?.status === "failed");
        }).pipe(Effect.provide(releasesWith(run)));
        assert.include(failed[0]?.reason ?? "", "failed verification");
      }),
    ).pipe(Effect.provide(nodeLayer)),
  );

  it.effect("fails a directory that is not a SlipJay project, without running SlipJay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const failed = yield* Effect.gen(function* () {
          const releases = yield* SlipJayReleases;
          yield* releases.promote({ cwd: root, repo: REPO });
          return yield* promotionsUntil((all) => all[0]?.status === "failed");
        }).pipe(Effect.provide(releasesWith((input) => Effect.die(`unexpected ${input.command}`))));
        assert.strictEqual(failed[0]?.reason, "This is not a SlipJay project.");
      }),
    ).pipe(Effect.provide(nodeLayer)),
  );

  it.effect("fails a checkout of another repository, without running SlipJay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* project;
        const failed = yield* Effect.gen(function* () {
          const releases = yield* SlipJayReleases;
          yield* releases.promote({ cwd: root, repo: "pechhe/weave" });
          return yield* promotionsUntil((all) => all[0]?.status === "failed");
        }).pipe(Effect.provide(releasesWith((input) => Effect.die(`unexpected ${input.command}`))));
        assert.deepStrictEqual(failed, [
          {
            repo: "pechhe/weave",
            status: "failed",
            candidate: null,
            reason: "This checkout does not publish pechhe/weave.",
          },
        ]);
      }),
    ).pipe(Effect.provide(nodeLayer)),
  );
});
