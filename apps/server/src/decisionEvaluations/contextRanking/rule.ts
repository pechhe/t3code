import type { DecisionRequest } from "@t3tools/contracts";
import { orderedCandidates, POOL_BY_ID } from "./caseBuilder.ts";
import type { RankingCase } from "./corpusTypes.ts";

export const RULE = { id: "context-ranking-pilot", version: "1" } as const;

/**
 * Selection rules, declared before any held-out call and never changed afterwards.
 * `TOP_K` is the primary comparison: it is scale-free, so it does not depend on either engine's probability calibration.
 */
export const TOP_K = 5;
export const THRESHOLD = 0.5;
/** Estimated tokens of candidate bodies a budgeted selection may include. */
export const TOKEN_BUDGET = 6000;
/** Estimator for body and request tokens, calibrated against the providers' reported counts in each result file. */
export const BYTES_PER_TOKEN = 4;

export const tokensOf = (bytes: number) => Math.ceil(bytes / BYTES_PER_TOKEN);

const QUESTION =
  "Is this candidate needed for the task? Answer true only if an engineer doing the task, with the already-included context and the other candidates, would likely miss a constraint, fact or procedure that matters without it. " +
  "A candidate that is merely related, similarly named, or only nice to have is not needed. Judge from the candidate's description.";

export const buildRequest = (
  engine: DecisionRequest["engine"],
  c: RankingCase,
): DecisionRequest => {
  const title = (id: string) => POOL_BY_ID.get(id)!.title;
  return {
    engine,
    rule: RULE,
    evidence: {
      task: c.task,
      alreadyIncluded: [...c.mandatory, ...c.requested].map(title),
      candidates: orderedCandidates(c).map(({ ref, id }) => {
        const item = POOL_BY_ID.get(id)!;
        return { ref, kind: item.kind, title: item.title, description: item.description };
      }),
    },
    questions: orderedCandidates(c).map(({ ref }) => ({
      id: ref,
      type: "predicate" as const,
      instructions: `${QUESTION} Candidate: ${ref}.`,
    })),
  };
};
