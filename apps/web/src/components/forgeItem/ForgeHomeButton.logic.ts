import type {
  ForgeHome,
  ForgeHomeInboxGroup,
  ForgeHomeLandingStage,
  ForgeHomeNeed,
  ForgeHomeState,
} from "@t3tools/contracts";

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

/** Weave's Forge Inbox groups, in its order. Forge files each entry in one (`need.group`) and words it. */
export const forgeInboxGroups = [
  { key: "accept", label: "Accept" },
  { key: "answer", label: "Answer" },
  { key: "review", label: "Review" },
] as const;
export type ForgeInboxGroup = ForgeHomeInboxGroup;

export const forgeInboxGroupOf = (need: ForgeHomeNeed): ForgeInboxGroup => need.group;

/** How a recently landed row's stage chip is styled: in production dark, waiting amber, the rest quiet. */
export const recentLandingTone = (
  stage: ForgeHomeLandingStage,
): "production" | "waiting" | "quiet" =>
  stage === "in_production"
    ? "production"
    : stage === "waiting_audit" || stage === "waiting_images" || stage === "waiting_deploy"
      ? "waiting"
      : "quiet";

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
