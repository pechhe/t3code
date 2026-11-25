import type { ModelSelection, ProjectId, TextGenerationError } from "@t3tools/contracts";
import type { Runner } from "./textGenerationOperations.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Relevance = Schema.Literals(["low", "medium", "high", "critical"]);

/**
 * The arguments of each Blackhole worker's one tool (pi-blackhole's record_observations,
 * record_reflections and drop_observations), with every field required so strict structured
 * output accepts them. Empty lists stand for the fields Pi leaves out.
 */
const BlackholeWorkerOutputs = {
  observer: Schema.Struct({
    observations: Schema.Array(
      Schema.Struct({
        content: Schema.String,
        relevance: Relevance,
        sourceEntryIds: Schema.Array(Schema.String),
        supersedes: Schema.Array(Schema.String),
      }),
    ),
    complete: Schema.Boolean,
  }),
  reflector: Schema.Struct({
    reflections: Schema.Array(
      Schema.Struct({
        content: Schema.String,
        supportingObservationIds: Schema.Array(Schema.String),
        relevance: Relevance,
        supersedes: Schema.Array(Schema.String),
      }),
    ),
    complete: Schema.Boolean,
  }),
  dropper: Schema.Struct({ ids: Schema.Array(Schema.String), reason: Schema.String }),
} as const;

export type BlackholeWorkerStage = keyof typeof BlackholeWorkerOutputs;

export interface BlackholeMemoryGenerationInput {
  readonly cwd: string;
  readonly stage: BlackholeWorkerStage;
  /** Blackhole's own system prompt for the worker. */
  readonly system: string;
  /** Blackhole's own task text for the worker, memory and chunk included. */
  readonly prompt: string;
  readonly toolName: string;
  readonly modelSelection: ModelSelection;
  readonly projectId?: ProjectId | null | undefined;
}

export type BlackholeMemoryGenerationResult =
  (typeof BlackholeWorkerOutputs)[BlackholeWorkerStage]["Type"];

/** One reply stands in for Pi's tool loop, so the worker gives its final batch whole. */
function buildBlackholeWorkerPrompt(
  input: Pick<BlackholeMemoryGenerationInput, "system" | "prompt" | "toolName">,
): string {
  return [
    input.system,
    "---",
    input.prompt,
    "---",
    `Answer with exactly one ${input.toolName} call, written as its JSON arguments and nothing else. ` +
      "Put the whole batch in it and set complete to true when the arguments have that field. " +
      "Use an empty list for any list you have nothing for.",
  ].join("\n\n");
}

export const blackholeMemoryFromRunner = (name: string, run: Runner) =>
  Effect.fn(`${name}.generateBlackholeMemory`)(function* (
    input: BlackholeMemoryGenerationInput,
  ): Effect.fn.Return<BlackholeMemoryGenerationResult, TextGenerationError> {
    const request = {
      operation: "generateBlackholeMemory",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      prompt: buildBlackholeWorkerPrompt(input),
    } as const;
    switch (input.stage) {
      case "observer":
        return yield* run({ ...request, outputSchema: BlackholeWorkerOutputs.observer });
      case "reflector":
        return yield* run({ ...request, outputSchema: BlackholeWorkerOutputs.reflector });
      case "dropper":
        return yield* run({ ...request, outputSchema: BlackholeWorkerOutputs.dropper });
    }
  });
