import type { DecisionRequest } from "@t3tools/contracts";
export const request = (engine: DecisionRequest["engine"] = "jev"): DecisionRequest => ({
  engine,
  rule: { id: "synthetic", version: "1" },
  evidence: { text: "Export fails; another way works." },
  questions: [
    { id: "workaround", type: "predicate", instructions: "Is there a workaround?" },
    {
      id: "area",
      type: "choice",
      instructions: "Which area?",
      choices: [
        { label: "export", description: "Export" },
        { label: "billing", description: "Billing" },
      ],
    },
    {
      id: "severity",
      type: "score",
      instructions: "How severe?",
      levels: [
        { label: "Cosmetic", description: "Appearance only; no lost functionality." },
        { label: "Workaround", description: "A task fails, but another way works." },
        { label: "Blocked", description: "Task fails with no workaround." },
      ],
    },
  ],
});
