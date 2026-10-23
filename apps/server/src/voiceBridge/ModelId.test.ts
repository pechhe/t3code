import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { modelsFromCapabilities } from "./Catalog.ts";
import { decodeModelId, encodeModelId } from "./ModelId.ts";

it.effect("round-trips a provider instance and a model id containing slashes", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(decodeModelId(encodeModelId("codex", "gpt-6.1-sol")), {
      instanceId: "codex",
      model: "gpt-6.1-sol",
    });
    assert.deepStrictEqual(decodeModelId(encodeModelId("pi", "opencode-go/deepseek-v4.1-flash")), {
      instanceId: "pi",
      model: "opencode-go/deepseek-v4.1-flash",
    });
  }),
);

it.effect("rejects ids that carry no model", () =>
  Effect.sync(() => {
    assert.isNull(decodeModelId("codex"));
    assert.isNull(decodeModelId("/gpt-6.1-sol"));
    assert.isNull(decodeModelId("codex/"));
  }),
);

it.effect("offers models only from providers that can start a thread", () =>
  Effect.sync(() => {
    const models = modelsFromCapabilities(
      {
        providers: [
          {
            providerInstanceId: "codex",
            displayName: "Codex",
            models: [{ id: "gpt-6.1-sol", label: "Sol" }],
            constraints: [],
          },
          {
            providerInstanceId: "cursor",
            displayName: "Cursor",
            models: [{ id: "cursor-fast" }],
            constraints: ["Provider instance is disabled."],
          },
          { providerInstanceId: "pi", displayName: null, models: [{ id: "  " }], constraints: [] },
        ],
      },
      1_700_000_000_000,
    );

    assert.deepStrictEqual(models, [
      {
        id: "codex/gpt-6.1-sol",
        object: "model",
        created: 1_700_000_000_000,
        owned_by: "codex",
        name: "Codex · Sol",
      },
    ]);
  }),
);
