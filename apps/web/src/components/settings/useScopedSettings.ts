import { RegistryContext } from "@effect/atom-react";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { use } from "react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type ServerSettingsPatch,
  type UnifiedSettings,
} from "@t3tools/contracts";

import {
  persistClientSettingsPatch,
  prepareModelPreferencesPatch,
  useMergedSettings,
  useToggleEnvironmentModelFavorite,
  useUpdateEnvironmentModelPreferences,
  useUpdateEnvironmentSettings,
} from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";

export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  return useMergedSettings(target?.settings ?? DEFAULT_SERVER_SETTINGS, selector);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return (plan: ReturnType<typeof planScopedSettingsPatch>, onFailed?: () => void) => {
    if (plan.unavailableReason) {
      toastManager.add({
        type: "warning",
        title: "Setting not saved",
        description: plan.unavailableReason,
      });
      onFailed?.();
      return;
    }
    void persistScopedSettingsPatch(
      plan,
      async (request) => {
        const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
          (scope) => !readEnvironmentScope(request.environmentId, scope),
        );
        if (missing)
          return AsyncResult.failure(
            Cause.fail(
              new EnvironmentAuthorizationError({
                requiredScope: missing,
                message: "This connection lacks permission to change these settings.",
              }),
            ),
          );
        return persistServer(request);
      },
      persistClientSettingsPatch,
    ).then(({ failedEnvironments, savedEnvironments, savedEnvironmentCount }) => {
      if (failedEnvironments.length === 0) return;
      onFailed?.();
      toastManager.add({
        type: "error",
        title:
          savedEnvironmentCount > 0 ? "Setting saved on some environments" : "Setting not saved",
        description: [
          ...failedEnvironments.map(
            ({ label, message }) => `Could not save on ${label}: ${message}`,
          ),
          ...(savedEnvironmentCount > 0
            ? [`Saved on ${savedEnvironments.map(({ label }) => label).join(", ")}.`]
            : []),
        ].join("\n"),
      });
    });
  };
}

export function useUpdateScopedSettings() {
  const { scope, environments, deviceOnly } = useSettingsScope();
  const run = useRunScopedPlan();
  /** `onFailed` runs when any target rejects or drops the patch, so a draft can fall back. */
  return (patch: ScopedSettingsPatch, options?: { readonly onFailed?: () => void }) =>
    run(planScopedSettingsPatch(scope, environments, patch, { deviceOnly }), options?.onFailed);
}

/**
 * Saves the per-model compact points. Under a settings scope they go to every environment the
 * scope covers (a model's point is a preference, not machine state); outside one, to this environment.
 */
export function useUpdateModelCompactAt(environmentId: EnvironmentId) {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  const updateEnvironmentSettings = useUpdateEnvironmentSettings(environmentId);
  return (modelCompactAt: ServerSettings["modelCompactAt"]) => {
    if (context === null) {
      void updateEnvironmentSettings({ modelCompactAt });
      return;
    }
    run(planScopedSettingsPatch(context.scope, context.environments, { modelCompactAt }));
  };
}

/**
 * Saves model preferences (favorites, hidden models, order) across all connected environments in
 * the active machine scope ("all" or "environment"), or the viewed environment otherwise.
 */
export function useUpdateScopedModelPreferences(environmentId: EnvironmentId) {
  const context = useOptionalSettingsScope();
  const updateSingle = useUpdateEnvironmentModelPreferences(environmentId);
  const registry = use(RegistryContext);
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return async (patch: ServerSettingsPatch) => {
    if (context === null) {
      return updateSingle(patch);
    }
    const scopedTargets =
      context.scope.kind === "all" || context.scope.kind === "environment"
        ? context.connectedEnvironments.map((environment) => ({
            environmentId: environment.environmentId,
            label: environment.label,
          }))
        : [];
    const targets =
      scopedTargets.length > 0
        ? scopedTargets
        : [{ environmentId, label: String(environmentId) }];

    const results = await Promise.all(
      targets.map(async (target) => {
        const settings = registry.get(serverEnvironment.settingsValueAtom(target.environmentId));
        if (!settings) {
          return { target, result: undefined, message: "Environment settings unavailable." };
        }
        let prepared: ServerSettingsPatch;
        try {
          prepared = await prepareModelPreferencesPatch(settings, patch);
        } catch {
          return {
            target,
            result: undefined,
            message: "Could not load saved model preferences.",
          };
        }
        if (!readEnvironmentScope(target.environmentId, AuthSettingsWriteScope)) {
          return {
            target,
            result: AsyncResult.failure<ServerSettings, EnvironmentAuthorizationError>(
              Cause.fail(
                new EnvironmentAuthorizationError({
                  requiredScope: AuthSettingsWriteScope,
                  message: "This connection lacks permission to change these settings.",
                }),
              ),
            ),
            message: "This connection lacks permission to change these settings.",
          };
        }
        const result = await persistServer({
          environmentId: target.environmentId,
          input: { patch: prepared },
        });
        if (result._tag === "Failure") {
          const error: unknown = Cause.squash(result.cause);
          return {
            target,
            result,
            message:
              error instanceof Error
                ? error.message
                : "The save failed. Try reconnecting and saving again.",
          };
        }
        return { target, result, message: undefined };
      }),
    );

    const failed = results.filter((entry) => entry.message !== undefined);
    const saved = results.filter((entry) => entry.message === undefined);
    if (failed.length > 0) {
      toastManager.add({
        type: "error",
        title:
          saved.length > 0
            ? "Model preferences saved on some environments"
            : "Model preferences not saved",
        description: [
          ...failed.map(({ target, message }) => `Could not save on ${target.label}: ${message}`),
          ...(saved.length > 0
            ? [`Saved on ${saved.map(({ target }) => target.label).join(", ")}.`]
            : []),
        ].join("\n"),
      });
    }
    return results.find((entry) => entry.target.environmentId === environmentId)?.result;
  };
}

export function useToggleScopedModelFavorite(environmentId: EnvironmentId) {
  const save = useUpdateScopedModelPreferences(environmentId);
  return useToggleEnvironmentModelFavorite(environmentId, save);
}

export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (keys: readonly ProjectScopedServerSettingKey[]) => {
    if (context === null) return;
    run(planScopedSettingsClear(context.scope, context.environments, keys));
  };
}

export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (
    entries: readonly ProjectOverrideEntry[],
    keys: readonly ProjectScopedServerSettingKey[],
  ) => {
    if (context === null) return;
    run(planProjectOverridesClear(context.environments, entries, keys));
  };
}

export function useScopedSettingsWriteAllowed() {
  const { connectedEnvironments } = useSettingsScope();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writable.has(target.environmentId))
  );
}
