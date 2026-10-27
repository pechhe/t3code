import type { ForgeHome, ForgeHomeNeed, ForgeHomeState } from "@t3tools/contracts";

/** The amber count on the Forge button: Needs you. Nothing, rather than 0, when none. */
export const buildButtonCount = (state: ForgeHomeState | null | undefined): number =>
  state?.status === "ready" || state?.status === "unavailable" ? (state.home?.count ?? 0) : 0;

/** The newer of a decision's own answer and the polled read, so a later poll is never hidden by an earlier decision. */
export const latestForgeHomeState = (
  decided: ForgeHomeState | null,
  polled: ForgeHomeState | null | undefined,
): ForgeHomeState | null => {
  if (decided === null) return polled ?? null;
  if (polled == null) return decided;
  return (polled.readAt ?? "") > (decided.readAt ?? "") ? polled : decided;
};

/** Inbox's two groups, as Weave's Inbox shows them (YS-260): Specs to accept, then what waits on you. */
export const forgeInboxGroups = [
  { key: "accept", label: "To accept" },
  { key: "waiting", label: "Waiting on you" },
] as const;
export type ForgeInboxGroup = (typeof forgeInboxGroups)[number]["key"];

export const forgeInboxGroupOf = (need: ForgeHomeNeed): ForgeInboxGroup =>
  need.kind === "acceptance" ? "accept" : "waiting";

/** One entry per need: a Spec once, a hold by its id, since one Spec can hold more than one question. */
export const buildInboxKey = (need: ForgeHomeNeed) =>
  need.kind === "hold" && need.holdId !== null
    ? `hold:${need.holdId}`
    : `${need.kind}:${need.spec.id}`;

/** Home's needs in Inbox order: every group in turn, each keeping Weave's order. */
export const buildInboxEntries = (home: ForgeHome | null): readonly ForgeHomeNeed[] =>
  home === null
    ? []
    : forgeInboxGroups.flatMap((group) =>
        home.needsYou.filter((need) => forgeInboxGroupOf(need) === group.key),
      );

/**
 * The selected entry: the one chosen, else the entry now at its place (after a decision the next
 * one, or the last when it was last), else the first.
 */
export const buildInboxSelection = (
  entries: readonly ForgeHomeNeed[],
  chosen: { key: string; index: number } | null,
): ForgeHomeNeed | null => {
  if (entries.length === 0) return null;
  if (chosen === null) return entries[0] ?? null;
  return (
    entries.find((need) => buildInboxKey(need) === chosen.key) ??
    entries[Math.min(chosen.index, entries.length - 1)] ??
    null
  );
};

/** Why an entry is in the Inbox: a few words for its row, and a line under its title. */
export const buildInboxReason = (need: ForgeHomeNeed): { label: string; detail: string } => {
  switch (need.kind) {
    case "acceptance":
      return { label: "To accept", detail: "Live on staging and reviewed" };
    case "hold":
      return need.holdKind === "decision"
        ? { label: "Your call", detail: "The agent is waiting for your decision" }
        : { label: "Question", detail: "The agent is waiting for information" };
    case "decision":
      return { label: "Decision", detail: "A Proposed Decision to accept or supersede" };
    case "arc_review":
      return {
        label: "Review date",
        detail: "The Arc reached its review date: continue with a new one, or close it",
      };
    case "arc_check_in":
      return { label: "Check in", detail: need.detail ?? "The Arc is due a check-in" };
  }
};
