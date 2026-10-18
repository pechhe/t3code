import type { ScopedProjectRef } from "@t3tools/contracts";
import type { SearchMiddleware } from "@tanstack/react-router";

import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";

export function validateSettingsRouteSearch(raw: Record<string, unknown>) {
  return validateSettingsScopeSearch(
    typeof raw.environmentId === "string" && raw.machine === undefined && raw.project === undefined
      ? { ...raw, machine: raw.environmentId }
      : raw,
  );
}

const SCOPE_KEYS = [
  "project",
  "machine",
  "checkout",
] as const satisfies readonly (keyof SettingsScopeSearch)[];
const TARGET_INPUT_KEYS = [...SCOPE_KEYS, "environmentId"];

export const retainSettingsScope: SearchMiddleware<SettingsScopeSearch> = ({ search, next }) => {
  const result = next(search);
  if (TARGET_INPUT_KEYS.some((key) => Object.hasOwn(result, key))) return result;
  const previousScope = Object.fromEntries(
    SCOPE_KEYS.filter((key) => search[key] !== undefined).map((key) => [key, search[key]]),
  );
  return { ...previousScope, ...result };
};

/**
 * The project the Projects page opens on when none is picked: the current
 * project, else the first.
 */
export function defaultSettingsProjectKey(
  groups: ReadonlyArray<{
    readonly projectKey: string;
    readonly memberProjectRefs: readonly ScopedProjectRef[];
  }>,
  currentProject: ScopedProjectRef | null,
): string | null {
  const current =
    currentProject &&
    groups.find((group) =>
      group.memberProjectRefs.some(
        (ref) =>
          ref.environmentId === currentProject.environmentId &&
          ref.projectId === currentProject.projectId,
      ),
    );
  return (current ?? groups[0])?.projectKey ?? null;
}
