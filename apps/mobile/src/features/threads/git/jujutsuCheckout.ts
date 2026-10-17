import type { VcsStatusResult } from "@t3tools/contracts";
import {
  resolveSlipJayBaseLabel,
  resolveSlipJayCheckout,
  resolveSlipJayLandingLabel,
  resolveSlipJayWorkspaceLabel,
} from "@t3tools/client-runtime/slipjay-checkout";

/**
 * How a Jujutsu checkout reads in place of a Git branch and its status: its SlipJay
 * workspace with its base, changed files and landing, as the web details card shows, or
 * else its changed files. Git actions do not apply to it. Null for any other checkout.
 */
export function resolveJujutsuCheckoutLabels(
  status: VcsStatusResult | null | undefined,
): { readonly title: string; readonly summary: string } | null {
  if (status?.otherVcsKind !== "jj") return null;
  const files = status.workingTree.files.length;
  const changed = files === 0 ? null : `${files} ${files === 1 ? "file" : "files"} changed`;
  const slipJay = resolveSlipJayCheckout(status);
  if (slipJay === null) {
    return { title: "Jujutsu checkout", summary: changed ?? "Clean" };
  }
  // The base label carries the changed files whenever slipjay.json names a base.
  const parts = [
    resolveSlipJayBaseLabel(slipJay, false) ?? changed,
    slipJay.landing === null ? null : resolveSlipJayLandingLabel(slipJay.landing),
  ].filter((part) => part !== null);
  return {
    title: resolveSlipJayWorkspaceLabel(slipJay, false),
    summary: parts.length === 0 ? "Clean" : parts.join(" · "),
  };
}
