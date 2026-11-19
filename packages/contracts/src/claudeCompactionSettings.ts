import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * A model choice, led by an empty choice with this label. With `instanceKey`, the sibling field
 * that stores the chosen account, it spans every account; without, only this account's models.
 */
export type ProviderSettingsModelOptions = {
  readonly emptyLabel: string;
  readonly instanceKey?: string | undefined;
};

/** The compaction fields ClaudeSettings carries: which model summarises, its account, and when. */
export const ClaudeCompactionSettingsFields = {
  compactModel: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: "Compact with",
      description:
        "The model that summarises a conversation when T3 Code compacts it. The conversation keeps its own model; a model on another account is written by that account and handed to this one. Unset, a compaction after the prompt cache has expired uses your Chore worker's models, and the next one if that one fails.",
      providerSettingsForm: {
        control: "model",
        modelOptions: {
          emptyLabel: "Chore worker (default)",
          instanceKey: "compactModelInstanceId",
        },
        clearWhenEmpty: "omit",
      },
    }),
  ),
  /** The account `compactModel` runs on; absent means this Claude instance. */
  compactModelInstanceId: Schema.optional(ProviderInstanceId).pipe(
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
  compactOnlyWhenCold: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateKey({
      title: "Only when the prompt cache has expired",
      description:
        "While a conversation's prompt cache is warm, its own model compacts it at a tenth of the input price. Off uses the model above every time.",
      providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
    }),
  ),
};
