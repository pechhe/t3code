import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  SlipJayCommandError,
  type VcsSlipJayPromoteInput,
  type VcsSlipJayPromoteResult,
  type VcsSlipJayPromotionPlan,
  type VcsSlipJayPromotionPlanInput,
} from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import { findSlipJayProject } from "../vcs/SlipJayProject.ts";

const Strings = Schema.optional(Schema.Array(Schema.String));

// `slipjay promote` prints one JSON document; only what the approval needs is read.
const decodePlan = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.String,
      reason: Schema.optional(Schema.String),
      integrationBranch: Schema.optional(Schema.String),
      releaseBranch: Schema.optional(Schema.String),
      candidate: Schema.optional(Schema.String),
      base: Schema.optional(Schema.String),
      subjects: Strings,
      checks: Strings,
      migrationArtifacts: Strings,
      nonAdditiveMigrations: Strings,
      halfBuiltSpecs: Schema.optional(
        Schema.Struct({
          specs: Schema.optional(
            Schema.Array(
              Schema.Struct({
                number: Schema.Number,
                title: Schema.String,
                url: Schema.String,
                closedTickets: Schema.Number,
                totalTickets: Schema.Number,
              }),
            ),
          ),
        }),
      ),
    }),
  ),
);

/** `slipjay promote`'s plan, or none when it printed no plan. */
export function promotionPlan(stdout: string): VcsSlipJayPromotionPlan | undefined {
  const plan = Option.getOrUndefined(decodePlan(stdout.trim()));
  if (plan === undefined) return undefined;
  return {
    status: plan.status,
    ...(plan.reason === undefined ? {} : { reason: plan.reason }),
    ...(plan.integrationBranch === undefined ? {} : { integrationBranch: plan.integrationBranch }),
    ...(plan.releaseBranch === undefined ? {} : { releaseBranch: plan.releaseBranch }),
    ...(plan.candidate === undefined ? {} : { candidate: plan.candidate }),
    ...(plan.base === undefined ? {} : { base: plan.base }),
    subjects: plan.subjects ?? [],
    checks: plan.checks ?? [],
    migrationArtifacts: plan.migrationArtifacts ?? [],
    nonAdditiveMigrations: plan.nonAdditiveMigrations ?? [],
    halfBuiltSpecs: plan.halfBuiltSpecs?.specs ?? [],
  };
}

const decodeConfirm = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      ok: Schema.optional(Schema.Boolean),
      status: Schema.String,
      reason: Schema.optional(Schema.String),
      production: Schema.optional(
        Schema.Struct({ status: Schema.String, reason: Schema.optional(Schema.String) }),
      ),
    }),
  ),
);

/**
 * `slipjay promote --confirm`'s result. A promotion has released only once production
 * deployed the candidate; without a printed result, SlipJay refused before submitting and
 * its last stderr line says why.
 */
export function promoteResult(output: {
  readonly stdout: string;
  readonly stderr: string;
}): VcsSlipJayPromoteResult {
  const result = Option.getOrUndefined(decodeConfirm(output.stdout.trim()));
  if (result === undefined) {
    const lines = output.stderr
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { released: false, status: "refused", messages: lines.slice(-1) };
  }
  const production = result.production;
  const released =
    result.ok === true &&
    (result.status === "released" || result.status === "released_by") &&
    (production === undefined || production.status === "deployed");
  const messages = [
    ...(result.reason === undefined ? [] : [result.reason]),
    ...(production === undefined
      ? []
      : [`Production ${production.status}${production.reason ? `: ${production.reason}` : ""}`]),
  ];
  return { released, status: result.status, messages };
}

const PROMOTE_OUTPUT_MAX_BYTES = 1024 * 1024;

/**
 * Promotions of a SlipJay project's staging candidate to its release branch and
 * production, through `slipjay promote`. Planning publishes nothing; confirming is the
 * owner's approval of one candidate, so only a person's request reaches it.
 */
export class SlipJayReleases extends Context.Service<
  SlipJayReleases,
  {
    readonly plan: (
      input: VcsSlipJayPromotionPlanInput,
    ) => Effect.Effect<VcsSlipJayPromotionPlan, SlipJayCommandError>;
    /**
     * Confirms the candidate and follows it through production. The promotion outlives
     * the request: an interrupted caller stops waiting, and a second request for the same
     * candidate joins the running one. A different candidate is refused while one runs,
     * since each approval names exactly one commit.
     */
    readonly promote: (
      input: VcsSlipJayPromoteInput,
    ) => Effect.Effect<VcsSlipJayPromoteResult, SlipJayCommandError>;
  }
>()("t3/project/SlipJayReleases") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const processes = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;

  // Only a SlipJay project's own checkout, so a client cannot run SlipJay anywhere else.
  const projectRoot = (cwd: string, operation: string, command: string) =>
    findSlipJayProject(cwd).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, processes),
      Effect.orElseSucceed(() => null),
      Effect.flatMap((project) =>
        project === null
          ? Effect.fail(
              new SlipJayCommandError({
                operation,
                command,
                cwd,
                detail: "This is not a SlipJay project.",
              }),
            )
          : Effect.succeed(project.root),
      ),
    );

  const plan: SlipJayReleases["Service"]["plan"] = Effect.fn("SlipJayReleases.plan")(function* ({
    cwd,
  }) {
    const failure = (detail: string, extra: { readonly cause?: unknown } = {}) =>
      new SlipJayCommandError({
        operation: "SlipJayReleases.plan",
        command: "slipjay promote",
        cwd,
        detail,
        ...extra,
      });
    const root = yield* projectRoot(cwd, "SlipJayReleases.plan", "slipjay promote");
    const output = yield* processes
      .run({
        command: "slipjay",
        args: ["promote"],
        cwd: root,
        // Planning fetches and asks GitHub about open Specs.
        timeout: "3 minutes",
        maxOutputBytes: PROMOTE_OUTPUT_MAX_BYTES,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError((cause) =>
          failure("SlipJay could not be run to plan a promotion.", { cause }),
        ),
      );
    const planned = promotionPlan(output.stdout);
    // SlipJay's stderr can carry runner URLs and paths, so it stays on the server.
    if (planned === undefined)
      return yield* failure(
        "SlipJay could not plan a promotion. Run `slipjay promote` in the project for details.",
      );
    return planned;
  });

  const promotions = yield* Ref.make(
    new Map<
      string,
      {
        readonly candidate: string;
        readonly result: Deferred.Deferred<VcsSlipJayPromoteResult, SlipJayCommandError>;
      }
    >(),
  );
  const runPromote = (root: string, candidate: string) =>
    processes
      .run({
        command: "slipjay",
        args: ["promote", "--confirm", candidate],
        cwd: root,
        // Release checks and the production deploy take minutes; the runner bounds them.
        timeout: "3 hours",
        maxOutputBytes: PROMOTE_OUTPUT_MAX_BYTES,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map(promoteResult),
        Effect.mapError(
          (cause) =>
            new SlipJayCommandError({
              operation: "SlipJayReleases.promote",
              command: "slipjay promote --confirm",
              cwd: root,
              detail: "SlipJay could not be run to promote.",
              cause,
            }),
        ),
      );

  const promote: SlipJayReleases["Service"]["promote"] = Effect.fn("SlipJayReleases.promote")(
    function* ({ cwd, candidate }) {
      const root = yield* projectRoot(cwd, "SlipJayReleases.promote", "slipjay promote --confirm");
      // Registering and starting are one step, so an interrupted caller cannot leave a
      // registration that no promotion will ever settle.
      const promotion = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const started = yield* Deferred.make<VcsSlipJayPromoteResult, SlipJayCommandError>();
          const running = yield* Ref.modify(promotions, (current) => {
            const existing = current.get(root);
            return existing === undefined
              ? [undefined, new Map(current).set(root, { candidate, result: started })]
              : [existing, current];
          });
          if (running !== undefined) {
            if (running.candidate === candidate) return running.result;
            return yield* new SlipJayCommandError({
              operation: "SlipJayReleases.promote",
              command: "slipjay promote --confirm",
              cwd: root,
              detail: `A promotion of ${running.candidate.slice(0, 8)} is still running for this project.`,
            });
          }
          yield* runPromote(root, candidate).pipe(
            Effect.onExit((exit) => Deferred.done(started, exit)),
            Effect.ensuring(
              Ref.update(promotions, (current) => {
                const next = new Map(current);
                next.delete(root);
                return next;
              }),
            ),
            Effect.forkIn(scope),
          );
          return started;
        }),
      );
      return yield* Deferred.await(promotion);
    },
  );

  return SlipJayReleases.of({ plan, promote });
});

export const layer = Layer.effect(SlipJayReleases, make).pipe(Layer.provide(ProcessRunner.layer));
