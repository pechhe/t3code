import * as Option from "effect/Option";

import type { ProviderInstanceId } from "./providerInstance.ts";
import { decodeClaudeSettings, type ServerSettings } from "./settings.ts";

/**
 * The instance's "Compact with" model, the account that runs it, and whether it applies only once
 * the prompt cache expired. `instanceId` is the account named by the setting, or this instance.
 */
export const resolveClaudeCompactionSetting = (
  settings: Pick<ServerSettings, "providerInstances">,
  instanceId: ProviderInstanceId,
): {
  readonly model: string;
  readonly instanceId: ProviderInstanceId;
  readonly onlyWhenCold: boolean;
} => {
  const instance = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  return decodeClaudeSettings(instance?.config ?? {}).pipe(
    Option.map((config) => ({
      model: config.compactModel,
      instanceId: config.compactModelInstanceId ?? instanceId,
      onlyWhenCold: config.compactOnlyWhenCold,
    })),
    Option.getOrElse(() => ({ model: "", instanceId, onlyWhenCold: true })),
  );
};
