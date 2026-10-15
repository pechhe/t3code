import type { RuntimeMode, DelegationRuntimeSettings } from "@t3tools/contracts";

const modes: readonly RuntimeMode[] = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];
export function defaultChildMode(
  parent: RuntimeMode,
  configured: DelegationRuntimeSettings["defaultChildRuntimeMode"],
): RuntimeMode {
  return configured === "inherit" || modes.indexOf(configured) > modes.indexOf(parent)
    ? parent
    : configured;
}
export function exceedsCaller(mode: RuntimeMode, parent: RuntimeMode): boolean {
  return modes.indexOf(mode) > modes.indexOf(parent);
}
