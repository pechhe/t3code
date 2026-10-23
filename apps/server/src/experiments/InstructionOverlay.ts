import type {
  ExperimentInstructionVariant,
  ModelSelection,
  OrchestrationV2AppThread,
  RunId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ExperimentService from "./ExperimentService.ts";

/** Providers whose adapters deliver an overlay: Claude's system prompt, Codex's context. */
const OVERLAY_DRIVERS = new Set(["claudeAgent", "codex"]);

export interface AssignedInstructionOverlay extends ExperimentInstructionVariant {
  readonly experimentId: string;
  readonly variantId: string;
}

/** Run decisions kept for the run's later readers; a run is read within moments of starting. */
const DECISIONS_KEPT = 512;

/**
 * The instruction experiment variant a thread's runs receive. The first run on a
 * provider that can deliver an overlay enrolls the thread; the assignment then holds for
 * every later run. Each run's overlay is decided once: the provider
 * turn and the run's setup record read the same decision, so the record names exactly what
 * was delivered, even when the lookup failed and nothing was sent.
 */
export class InstructionOverlay extends Context.Service<
  InstructionOverlay,
  {
    /** The overlay this run delivers, or null for none; never fails a run. */
    readonly forRun: (input: {
      readonly runId: RunId;
      readonly thread: Pick<OrchestrationV2AppThread, "id" | "projectId" | "createdAt">;
      readonly modelSelection: ModelSelection;
      readonly driver: string;
    }) => Effect.Effect<AssignedInstructionOverlay | null>;
  }
>()("t3/experiments/InstructionOverlay") {}

export const layer = Layer.effect(
  InstructionOverlay,
  Effect.gen(function* () {
    const experiments = yield* ExperimentService.ExperimentService;
    const decide = Effect.fn("InstructionOverlay.decide")(
      function* (input: Parameters<InstructionOverlay["Service"]["forRun"]>[0]) {
        if (!OVERLAY_DRIVERS.has(input.driver)) return null;
        const assignments = yield* experiments.assignForThread({
          threadLever: "instruction",
          threadId: input.thread.id,
          projectId: input.thread.projectId,
          modelSelection: input.modelSelection,
          enrollment: "new",
          unitCreatedAt: DateTime.formatIso(input.thread.createdAt),
        });
        const assignment = assignments.find(
          (candidate) =>
            candidate.lever === "instruction" &&
            candidate.unitKind === "thread" &&
            candidate.assignmentMethod === "randomized" &&
            candidate.variant.instructions !== undefined,
        );
        const instructions = assignment?.variant.instructions;
        return assignment === undefined || instructions === undefined
          ? null
          : {
              ...instructions,
              experimentId: assignment.experimentId,
              variantId: assignment.variant.id,
            };
      },
      (effect, input) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Instruction overlay unavailable", {
              threadId: input.thread.id,
              cause,
            }).pipe(Effect.as(null)),
          ),
        ),
    );
    const decisions = new Map<string, Deferred.Deferred<AssignedInstructionOverlay | null>>();
    return InstructionOverlay.of({
      forRun: (input) =>
        Effect.suspend(() => {
          const known = decisions.get(input.runId);
          if (known !== undefined) return Deferred.await(known);
          const decision = Deferred.makeUnsafe<AssignedInstructionOverlay | null>();
          decisions.set(input.runId, decision);
          if (decisions.size > DECISIONS_KEPT) decisions.delete(decisions.keys().next().value!);
          // Runs to completion even if this reader is interrupted, so later readers never wait
          // on a decision nobody finishes.
          return Deferred.into(Effect.uninterruptible(decide(input)), decision).pipe(
            Effect.andThen(Deferred.await(decision)),
          );
        }),
    });
  }),
);

/** No instruction experiments: for code paths and tests without the experiment service. */
export const layerEmpty = Layer.succeed(
  InstructionOverlay,
  InstructionOverlay.of({ forRun: () => Effect.succeed(null) }),
);
