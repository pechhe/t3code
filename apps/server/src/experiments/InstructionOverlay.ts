import type {
  ExperimentAllocationPolicy,
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

/** What a delivery-approach trial tells a lead. Guidance, so its report measures what happened. */
export const APPROACH_OVERLAYS = {
  "inline-first": {
    sourcePath: "delegation-approach",
    revision: "inline-first",
    sha256: "9764f097e0f06f460547fe23a9c23fd9a1a7c1b20b8429793b58aadfbb732f52",
    text: "For this work, do the work yourself first and delegate only what you cannot do inline.",
  },
  "delegate-earlier": {
    sourcePath: "delegation-approach",
    revision: "delegate-earlier",
    sha256: "6fcc954efb90774cfb0fda8bba7735ae06682e34cfd3e287d971fad2f67d1045",
    text: "For this work, hand bounded work to a helper as soon as you can, and keep the coordination yourself.",
  },
} as const satisfies Record<ExperimentAllocationPolicy, ExperimentInstructionVariant>;

/** Run decisions kept for the run's later readers; a run is read within moments of starting. */
const DECISIONS_KEPT = 512;

/**
 * Enroll on the first overlay-capable run and retain that assignment for later runs.
 * Decide each overlay once so delivery and setup recording agree, including lookup failure.
 */
export class InstructionOverlay extends Context.Service<
  InstructionOverlay,
  {
    /** The overlay this run delivers, or null for none; never fails a run. */
    readonly forRun: (input: {
      readonly runId: RunId;
      /** Absent for a run that cannot start delivery work, such as a tool-only path. */
      readonly runOrdinal?: number;
      readonly thread: Pick<OrchestrationV2AppThread, "id" | "projectId" | "createdAt"> &
        Partial<
          Pick<OrchestrationV2AppThread, "agentTask" | "lineage" | "workItem" | "workspaceIssue">
        >;
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
        const topLevel = input.thread.lineage?.parentThreadId == null;
        const role = input.thread.agentTask?.role ?? (topLevel ? ("lead" as const) : undefined);
        const assignments = yield* experiments.assignForThread({
          threadLever: "instruction",
          ...(role === undefined ? {} : { agentRole: role }),
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
        if (assignment !== undefined && instructions !== undefined)
          return {
            ...instructions,
            experimentId: assignment.experimentId,
            variantId: assignment.variant.id,
          };
        // Enrolling only a fresh thread linked to its item keeps inline work in the comparison;
        // a link added after the lead has started is too late to change how it starts.
        const item = input.thread.workItem?.number ?? input.thread.workspaceIssue ?? undefined;
        const enrolled =
          topLevel && item !== undefined && input.runOrdinal === 1
            ? yield* experiments.assign({
                unitKind: "thread",
                unitId: `delivery:${item}`,
                threadLever: "orchestration-policy",
                agentRole: "lead",
                threadId: input.thread.id,
                projectId: input.thread.projectId,
                modelSelection: input.modelSelection,
                enrollment: "new",
                unitCreatedAt: DateTime.formatIso(input.thread.createdAt),
              })
            : topLevel
              ? yield* experiments.assignments({ threadId: input.thread.id })
              : [];
        const delivery = enrolled.find(
          (candidate) =>
            candidate.lever === "orchestration-policy" &&
            candidate.unitKind === "thread" &&
            candidate.variant.allocationPolicy !== undefined,
        );
        return delivery === undefined
          ? null
          : {
              ...APPROACH_OVERLAYS[delivery.variant.allocationPolicy!],
              experimentId: delivery.experimentId,
              variantId: delivery.variant.id,
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
      forRun: Effect.fn("InstructionOverlay.forRun")((input) =>
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
      ),
    });
  }),
);

/** No instruction experiments: for code paths and tests without the experiment service. */
export const layerEmpty = Layer.succeed(
  InstructionOverlay,
  InstructionOverlay.of({
    forRun: Effect.fn("InstructionOverlay.forRun")(() => Effect.succeed(null)),
  }),
);
