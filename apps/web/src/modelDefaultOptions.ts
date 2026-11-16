import type { ModelSelection, ServerSettings } from "@t3tools/contracts";

/**
 * Starts `selection` at the options the user set as its model's defaults, such as a reasoning
 * level, over any the device remembered from its last pick.
 */
export function withModelDefaultOptions(
  selection: ModelSelection,
  settings: Pick<ServerSettings, "providerModelPreferences">,
): ModelSelection {
  const defaults =
    settings.providerModelPreferences?.[selection.instanceId]?.defaultOptions?.[selection.model];
  if (!defaults || defaults.length === 0) return selection;
  const ids = new Set(defaults.map((option) => option.id));
  return {
    ...selection,
    options: [...(selection.options ?? []).filter((option) => !ids.has(option.id)), ...defaults],
  };
}
