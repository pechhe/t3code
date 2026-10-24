import { encodeModelId } from "./ModelId.ts";

/** The provider and model facts the bridge needs, as `orchestrator_capabilities` reports them. */
export type ProviderModelSet = {
  readonly providerInstanceId: string;
  readonly displayName: string | null;
  readonly models: ReadonlyArray<{ readonly id: string; readonly label?: string | undefined }>;
  readonly constraints: ReadonlyArray<string>;
};

export type ProviderModels = {
  /** The environment's id, used to build a thread link that opens outside T3. */
  readonly environmentId: string | null;
  readonly providers: ReadonlyArray<ProviderModelSet>;
};

/** One entry of the OpenAI-compatible `/v1/models` answer. */
export type OpenAiModel = {
  readonly id: string;
  readonly object: "model";
  readonly created: number;
  readonly owned_by: string;
  readonly name: string;
};

/**
 * The models a voice ask may run on: every model of a provider T3 reports as
 * usable. A provider with any constraint is disabled, uninstalled or otherwise
 * unable to start a thread, so it is left out rather than offered and refused.
 */
export function modelsFromCapabilities(
  capabilities: ProviderModels,
  created: number,
): ReadonlyArray<OpenAiModel> {
  const models: Array<OpenAiModel> = [];
  for (const provider of capabilities.providers) {
    if (provider.constraints.length > 0) continue;
    const owner = provider.displayName ?? provider.providerInstanceId;
    for (const model of provider.models) {
      if (model.id.trim() === "") continue;
      models.push({
        id: encodeModelId(provider.providerInstanceId, model.id),
        object: "model",
        created,
        owned_by: provider.providerInstanceId,
        name: `${owner} · ${model.label ?? model.id}`,
      });
    }
  }
  return models;
}
