import { type DelegationStance } from "@t3tools/contracts";

const notes: Record<DelegationStance, string> = {
  orchestrate:
    "Delegation stance: orchestrate. This thread owns the outcome, the decisions and the checking. Hand building to implementers wherever the design is settled and an available implementer's note suits the work, UI building included. Keep design work that is still open and the rounds with the user. When no available implementer suits a piece, build that piece yourself rather than give it to a model whose note says it is poor at it. A small fix you may make yourself.",
  flexible:
    "Delegation stance: flexible. Hand off bounded pieces with a settled interface and build the coupled parts yourself.",
  implement:
    "Delegation stance: implement. Build everything yourself; read-only helpers (scout, researcher, browser, reviewer, advisor) are fine. T3 refuses to start an implementer for this thread.",
};

export const delegationStanceNote = (stance: DelegationStance, readOnly = false): string =>
  readOnly ? "" : notes[stance];
