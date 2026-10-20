import type { BuildHomeAcceptanceNeed, BuildHomeState } from "@t3tools/contracts";

/** The amber count on the Build button: Needs you and Stuck. Nothing, rather than 0, when none. */
export const buildButtonCount = (state: BuildHomeState | null | undefined): number =>
  state?.status === "ready" || state?.status === "unavailable" ? (state.home?.count ?? 0) : 0;

/** Send back needs a note; Accept needs only a card to decide on. */
export const buildDecisionEnabled = (
  need: Pick<BuildHomeAcceptanceNeed, "card">,
  decision: "accept" | "send_back",
  note: string,
) => need.card !== null && (decision === "accept" || note.trim() !== "");

/** Build's objective checks for an owner card, as badge labels with whether each is good. */
export function buildAcceptanceBadges(need: BuildHomeAcceptanceNeed) {
  return [
    need.staging === "carried"
      ? { label: "On staging", good: true }
      : need.staging === "not_required"
        ? { label: "Staging not required", good: true }
        : need.staging === "not_carried"
          ? { label: "Not on staging yet", good: false }
          : { label: "No staging deploy yet", good: false },
    {
      label: `${need.rowsMet} of ${need.rowsTotal} rows met`,
      good: need.rowsMet === need.rowsTotal,
    },
    need.blockingFindings === 0
      ? { label: "No blocking findings", good: true }
      : { label: `${need.blockingFindings} blocking`, good: false },
  ];
}

/** The newer of a decision's own answer and the polled read, so a later poll is never hidden by an earlier decision. */
export const latestBuildHomeState = (
  decided: BuildHomeState | null,
  polled: BuildHomeState | null | undefined,
): BuildHomeState | null => {
  if (decided === null) return polled ?? null;
  if (polled == null) return decided;
  return (polled.readAt ?? "") > (decided.readAt ?? "") ? polled : decided;
};
