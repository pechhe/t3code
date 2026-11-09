import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  type VcsSlipJayDismissPromotionInput,
  type VcsSlipJayPromoteInput,
  type VcsSlipJayPromotion,
} from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import { findSlipJayProject } from "../vcs/SlipJayProject.ts";
import { SlipJayLandings } from "./SlipJayLandings.ts";

// `slipjay promote` prints one JSON document; only what deciding to confirm needs is read.
const decodePlan = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.String,
      reason: Schema.optional(Schema.String),
      candidate: Schema.optional(Schema.String),
      verification: Schema.optional(
        Schema.Struct({ status: Schema.String, failedCommand: Schema.optional(Schema.String) }),
      ),
    }),
  ),
);

/**
 * What `slipjay promote`'s plan lets a release do next. A failed verification is fixed by a
 * landing, never confirmed around; an unfinished one is the confirm's to run or refuse.
 */
export function promotionNextStep(
  stdout: string,
):
  | { readonly next: "confirm"; readonly candidate: string }
  | { readonly next: "nothing" }
  | { readonly next: "stop"; readonly reason: string } {
  const plan = Option.getOrUndefined(decodePlan(stdout.trim()));
  // SlipJay's stderr can carry runner URLs and paths, so it stays on the server.
  if (plan === undefined) {
    return {
      next: "stop",
      reason: "SlipJay could not plan a release. Run `slipjay promote` in the project for details.",
    };
  }
  if (plan.status === "up_to_date") return { next: "nothing" };
  if (plan.status !== "planned" || plan.candidate === undefined) {
    return { next: "stop", reason: plan.reason ?? `SlipJay will not release (${plan.status}).` };
  }
  if (plan.verification?.status === "failed") {
    const command = plan.verification.failedCommand;
    return {
      next: "stop",
      reason: `${plan.candidate.slice(0, 7)} failed verification${command === undefined ? "" : ` at ${command}`}. A fix that lands and passes becomes the next candidate.`,
    };
  }
  return { next: "confirm", candidate: plan.candidate };
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
export function promoteResult(output: { readonly stdout: string; readonly stderr: string }): {
  readonly released: boolean;
  readonly status: string;
  readonly messages: ReadonlyArray<string>;
} {
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
 * Releases of a repository through `slipjay promote`: its plan, then the confirm of exactly
 * the planned candidate, the route agents use. Only a person's request reaches it.
 */
export class SlipJayReleases extends Context.Service<
  SlipJayReleases,
  {
    /**
     * Starts a release and returns: it outlives the request, and what becomes of it is in
     * `promotions`. A request for a repository already releasing joins the running one.
     */
    readonly promote: (input: VcsSlipJayPromoteInput) => Effect.Effect<void>;
    /** Forgets a failed release, whose failure otherwise stays until the next attempt. */
    readonly dismiss: (input: VcsSlipJayDismissPromotionInput) => Effect.Effect<void>;
    /** The releases running or failed, current value first. A successful one leaves the list. */
    readonly promotions: Stream.Stream<ReadonlyArray<VcsSlipJayPromotion>>;
  }
>()("t3/project/SlipJayReleases") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const processes = yield* ProcessRunner.ProcessRunner;
  const landings = yield* SlipJayLandings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const promotions = yield* SubscriptionRef.make<ReadonlyArray<VcsSlipJayPromotion>>([]);

  const replace = (
    repo: string,
    next: (current: VcsSlipJayPromotion | undefined) => VcsSlipJayPromotion | null,
  ) =>
    SubscriptionRef.update(promotions, (all) => {
      const updated = next(all.find((promotion) => promotion.repo === repo));
      return [
        ...all.filter((promotion) => promotion.repo !== repo),
        ...(updated === null ? [] : [updated]),
      ];
    });

  /** Runs the release to its end: null when nothing is left to report, else why it failed. */
  const release = Effect.fn("SlipJayReleases.release")(
    function* (cwd: string, repo: string) {
      // Only a SlipJay project's own checkout, so a client cannot run SlipJay anywhere else.
      const project = yield* findSlipJayProject(cwd).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ProcessRunner.ProcessRunner, processes),
        Effect.orElseSucceed(() => null),
      );
      if (project === null) return "This is not a SlipJay project.";
      // A promotion is filed under `repo`, so it must be what this checkout would ship.
      const repository = yield* landings.repositoryOf(project.root);
      if (repository?.toLowerCase() !== repo.toLowerCase()) {
        return `This checkout does not publish ${repo}.`;
      }
      const planned = yield* processes.run({
        command: "slipjay",
        args: ["promote"],
        cwd: project.root,
        // Planning fetches and asks GitHub about open Specs.
        timeout: "3 minutes",
        maxOutputBytes: PROMOTE_OUTPUT_MAX_BYTES,
        outputMode: "truncate",
      });
      const step = promotionNextStep(planned.stdout);
      if (step.next === "nothing") return null;
      if (step.next === "stop") return step.reason;
      yield* replace(repo, () => ({
        repo,
        status: "releasing",
        candidate: step.candidate,
        reason: null,
      }));
      const confirmed = yield* processes.run({
        command: "slipjay",
        args: ["promote", "--confirm", step.candidate],
        cwd: project.root,
        // Release checks and the production deploy take minutes; the runner bounds them.
        timeout: "3 hours",
        maxOutputBytes: PROMOTE_OUTPUT_MAX_BYTES,
        outputMode: "truncate",
      });
      const { released, status, messages } = promoteResult(confirmed);
      if (released) return null;
      return messages.length === 0 ? `Release ${status}.` : messages.join("\n");
    },
    Effect.catch((cause) =>
      Effect.logWarning("SlipJay could not be run to release", { cause }).pipe(
        Effect.as("SlipJay could not be run."),
      ),
    ),
  );

  const promote: SlipJayReleases["Service"]["promote"] = Effect.fn("SlipJayReleases.promote")(
    function* ({ cwd, repo }) {
      // Claiming and starting are one step, so an interrupted caller cannot leave a claim
      // that no release will ever settle.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const claimed = yield* SubscriptionRef.modify(
            promotions,
            (all): readonly [boolean, ReadonlyArray<VcsSlipJayPromotion>] =>
              all.some((promotion) => promotion.repo === repo && promotion.status === "releasing")
                ? [false, all]
                : [
                    true,
                    [
                      ...all.filter((promotion) => promotion.repo !== repo),
                      { repo, status: "releasing", candidate: null, reason: null },
                    ],
                  ],
          );
          if (!claimed) return;
          yield* release(cwd, repo).pipe(
            Effect.onExit((exit) =>
              replace(repo, (current) => {
                const reason = Exit.isSuccess(exit) ? exit.value : "The release stopped early.";
                return reason === null
                  ? null
                  : { repo, status: "failed", candidate: current?.candidate ?? null, reason };
              }),
            ),
            Effect.forkIn(scope),
          );
        }),
      );
    },
  );

  const dismiss: SlipJayReleases["Service"]["dismiss"] = ({ repo }) =>
    replace(repo, (current) => (current?.status === "releasing" ? current : null));

  return SlipJayReleases.of({
    promote,
    dismiss,
    promotions: SubscriptionRef.changes(promotions),
  });
});

export const layer = Layer.effect(SlipJayReleases, make).pipe(Layer.provide(ProcessRunner.layer));
