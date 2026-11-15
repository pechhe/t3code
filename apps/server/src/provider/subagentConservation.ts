import { conservationModelsOf } from "@t3tools/shared/usageLimits";
import type {
  ServerProvider,
  SubagentConservationRule,
  SubagentConservationStatus,
} from "@t3tools/contracts";

export type ConservationMemory = {
  readonly fingerprint: string;
  readonly ruleKey: string;
  readonly state: "ready" | "active";
};

export function conservationNeedsRefresh(
  provider: ServerProvider,
  rule: SubagentConservationRule,
  now: number,
): boolean {
  const limits = provider.usageLimits;
  const windows = limits?.windows.filter((window) =>
    rule.window === "any" ? true : window.id === rule.window,
  );
  return (
    !limits ||
    !limits.credentialFingerprint ||
    !!limits.unavailable ||
    !windows?.length ||
    now - Date.parse(limits.checkedAt) >= 60_000 ||
    windows.some((window) => window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now)
  );
}

export function evaluateConservation(
  provider: ServerProvider,
  rule: SubagentConservationRule,
  now: number,
  memory?: ConservationMemory,
  identity?: { readonly current: string | undefined },
): { status: SubagentConservationStatus; memory?: ConservationMemory } {
  if (provider.conservationScope?.providerIds.length === 0)
    return {
      status: {
        state: "unknown",
        unavailable: true,
        models: [],
        message:
          provider.conservationScope.reason ??
          "This connection cannot identify which models use the reported account. Subscription conservation is unavailable.",
      },
    };
  const limits = provider.usageLimits;
  const fingerprint =
    identity === undefined || identity.current === limits?.credentialFingerprint
      ? limits?.credentialFingerprint
      : undefined;
  const ruleKey = JSON.stringify([rule.remainingPercent, rule.window, rule.windowIds]);
  const previous =
    fingerprint && memory?.fingerprint === fingerprint && memory.ruleKey === ruleKey
      ? memory
      : undefined;
  const ids =
    rule.window === "any"
      ? [...new Set([...rule.windowIds, ...(limits?.windows.map((window) => window.id) ?? [])])]
      : [rule.window];
  const windows = ids.map((id) => limits?.windows.find((window) => window.id === id));
  const fresh = !!fingerprint && !conservationNeedsRefresh(provider, rule, now);
  const low =
    fresh &&
    windows.some(
      (window) => window !== undefined && 100 - window.usedPercent <= rule.remainingPercent,
    );
  const complete = fresh && windows.length > 0 && windows.every((window) => window !== undefined);
  const state = low ? "active" : complete ? "ready" : (previous?.state ?? "unknown");
  const next =
    low || complete
      ? { fingerprint: fingerprint!, ruleKey, state: state as "ready" | "active" }
      : previous;
  const unavailable = !complete;
  const message = !fingerprint
    ? "Usage unavailable: this connection cannot safely identify its account. Selected models are excluded until an identified reading is available."
    : unavailable
      ? state === "unknown"
        ? "Usage unavailable: no usable reading yet. Selected models are excluded until usage can be checked."
        : `Usage unavailable or stale. Keeping the last known ${state} state until a fresh reading is available.${state === "ready" ? " Starts are still permitted; this does not guarantee an unspent reserve." : ""}`
      : state === "active"
        ? `Conservation active: selected models are skipped for new subagents at or below ${rule.remainingPercent}% usage remaining.`
        : `Conservation ready: selected models are available above ${rule.remainingPercent}% usage remaining.`;
  return {
    status: { state, unavailable, models: conservationModelsOf(provider, rule.models), message },
    ...(next ? { memory: next } : {}),
  };
}
