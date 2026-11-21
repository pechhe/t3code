// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ServerProviderModel,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "node:path";

import { EMPTY_PI_MODEL_CAPABILITIES } from "./modelCapabilities.ts";
import {
  buildPiEnabledModelsFromPreferences,
  matchesPiEnabledModelPattern,
  parsePiEnabledModels,
  reconcilePiScopedModels,
  resolvePiModelPreferencesFromEnabledModels,
  writePiEnabledModels,
} from "./enabledModels.ts";

const model = (slug: string, isCustom = false): ServerProviderModel => {
  const slash = slug.indexOf("/");
  const subProvider = slash >= 0 ? slug.slice(0, slash) : undefined;
  return {
    slug,
    name: slug,
    ...(subProvider === undefined ? {} : { subProvider }),
    isCustom,
    capabilities: EMPTY_PI_MODEL_CAPABILITIES,
  };
};

const catalog: ReadonlyArray<ServerProviderModel> = [
  model("default"),
  model("opencode-go/deepseek-v4.1-flash"),
  model("claude-subscription-hfpetch/claude-opus-5-5"),
  model("openrouter/google/gemini-4-neon"),
  model("openrouter/google/gemini-4-neon:batch"),
  model("antigravity/gemini-4-hydrogen"),
];

describe("matchesPiEnabledModelPattern", () => {
  it("matches exact provider/id, bare id, thinking suffixes and globs while keeping :batch distinct", () => {
    const opus = model("claude-subscription-hfpetch/claude-opus-5-5");
    const neon = model("openrouter/google/gemini-4-neon");
    const neonBatch = model("openrouter/google/gemini-4-neon:batch");

    assert.isTrue(
      matchesPiEnabledModelPattern("claude-subscription-hfpetch/claude-opus-5-5", opus),
    );
    assert.isTrue(
      matchesPiEnabledModelPattern("claude-subscription-hfpetch/claude-opus-5-5:high", opus),
    );
    assert.isTrue(matchesPiEnabledModelPattern("claude-opus-5-5:max", opus));
    assert.isTrue(matchesPiEnabledModelPattern("openrouter/google/*", neon));
    assert.isFalse(matchesPiEnabledModelPattern("openrouter/google/gemini-4-neon", neonBatch));
    assert.isTrue(matchesPiEnabledModelPattern("openrouter/google/gemini-4-neon:batch", neonBatch));
  });
});

describe("resolvePiModelPreferencesFromEnabledModels", () => {
  it("hides every discovered model outside Pi's enabledModels, including new provider models, and appends newly enabled models to the order", () => {
    const resolved = resolvePiModelPreferencesFromEnabledModels({
      enabledModels: ["antigravity/gemini-4-hydrogen:high", "opencode-go/deepseek-v4.1-flash"],
      discoveredModels: catalog,
      currentPreferences: {
        hiddenModels: ["default", "opencode-go/deepseek-v4.1-flash"],
        modelOrder: ["claude-subscription-hfpetch/claude-opus-5-5"],
      },
    });
    assert.isNotNull(resolved);
    assert.deepEqual(resolved?.enabledSlugs, [
      "antigravity/gemini-4-hydrogen",
      "opencode-go/deepseek-v4.1-flash",
    ]);
    assert.deepEqual(resolved?.hiddenModels, [
      "default",
      "claude-subscription-hfpetch/claude-opus-5-5",
      "openrouter/google/gemini-4-neon",
      "openrouter/google/gemini-4-neon:batch",
    ]);
    assert.deepEqual(resolved?.modelOrder, [
      "claude-subscription-hfpetch/claude-opus-5-5",
      "antigravity/gemini-4-hydrogen",
      "opencode-go/deepseek-v4.1-flash",
    ]);
  });

  it("keeps preferences for models another machine's Pi lists, so shared settings settle instead of reverting", () => {
    const currentPreferences = {
      hiddenModels: [
        "anthropic/claude-opus-5-5",
        "openrouter/google/gemini-4-neon",
        "openai/gpt-4",
        "openrouter/google/gemini-4-neon:batch",
      ],
      modelOrder: [
        "openai/gpt-6-luna",
        "opencode-go/deepseek-v4.1-flash",
        "anthropic/claude-sonnet-5-5",
        "antigravity/gemini-4-hydrogen",
      ],
    };
    const resolved = resolvePiModelPreferencesFromEnabledModels({
      enabledModels: [
        "antigravity/gemini-4-hydrogen",
        "opencode-go/deepseek-v4.1-flash",
        "claude-subscription-hfpetch/claude-opus-5-5",
      ],
      discoveredModels: catalog,
      currentPreferences,
    });
    assert.deepEqual(resolved?.hiddenModels, currentPreferences.hiddenModels);
    assert.deepEqual(resolved?.modelOrder, [
      "openai/gpt-6-luna",
      "antigravity/gemini-4-hydrogen",
      "anthropic/claude-sonnet-5-5",
      "opencode-go/deepseek-v4.1-flash",
      "claude-subscription-hfpetch/claude-opus-5-5",
    ]);
    assert.deepEqual(
      resolvePiModelPreferencesFromEnabledModels({
        enabledModels: resolved!.enabledSlugs,
        discoveredModels: catalog,
        currentPreferences: resolved!,
      }),
      resolved,
    );
  });

  it("leaves T3 preferences alone when Pi has no enabledModels scope or an empty array", () => {
    assert.isNull(parsePiEnabledModels('{"enabledModels":[]}'));
    assert.isNull(
      resolvePiModelPreferencesFromEnabledModels({
        enabledModels: null,
        discoveredModels: catalog,
      }),
    );
    assert.isNull(
      resolvePiModelPreferencesFromEnabledModels({
        enabledModels: [],
        discoveredModels: catalog,
      }),
    );
  });
});

describe("buildPiEnabledModelsFromPreferences", () => {
  it("writes enabled models in T3's modelOrder, keeps thinking suffixes and unmatched entries, and includes favorites", () => {
    const next = buildPiEnabledModelsFromPreferences({
      existingEnabledModels: [
        "opencode-go/deepseek-v4.1-flash:high",
        "offline-provider/custom-model",
      ],
      discoveredModels: catalog,
      preferences: {
        hiddenModels: [
          "default",
          "openrouter/google/gemini-4-neon",
          "openrouter/google/gemini-4-neon:batch",
          "antigravity/gemini-4-hydrogen",
        ],
        modelOrder: [
          "claude-subscription-hfpetch/claude-opus-5-5",
          "opencode-go/deepseek-v4.1-flash",
        ],
      },
      favoriteModels: ["antigravity/gemini-4-hydrogen"],
    });

    assert.deepEqual(next, [
      "claude-subscription-hfpetch/claude-opus-5-5",
      "opencode-go/deepseek-v4.1-flash:high",
      "antigravity/gemini-4-hydrogen",
      "offline-provider/custom-model",
    ]);
  });

  it("clears enabledModels when every discovered model is enabled and no extra pattern, glob or thinking pin remains", () => {
    assert.isNull(
      buildPiEnabledModelsFromPreferences({
        existingEnabledModels: ["opencode-go/deepseek-v4.1-flash"],
        discoveredModels: catalog,
        preferences: { hiddenModels: ["default"], modelOrder: [] },
      }),
    );
  });

  it("preserves a glob pattern when all of its matched models stay enabled, even if it matches the whole current catalog", () => {
    const openrouterOnly = [
      model("default"),
      model("openrouter/google/gemini-4-neon"),
      model("openrouter/google/gemini-4-neon:batch"),
    ];
    assert.deepEqual(
      buildPiEnabledModelsFromPreferences({
        existingEnabledModels: ["openrouter/*"],
        discoveredModels: openrouterOnly,
        preferences: { hiddenModels: ["default"], modelOrder: [] },
      }),
      ["openrouter/*"],
    );
  });
});

describe("reconcilePiScopedModels", () => {
  const instanceId = ProviderInstanceId.make("pi");
  const withAgentDir = <A, E>(
    use: (agentDir: string) => Effect.Effect<A, E, FileSystem.FileSystem>,
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const agentDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-scoped-models-" });
      return yield* use(agentDir);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.orDie);

  it.effect(
    "syncs Pi's enabledModels into T3 preferences and writes T3 edits back to Pi's settings.json",
    () =>
      withAgentDir((agentDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const settingsPath = NodePath.join(agentDir, "settings.json");
          yield* fileSystem.writeFileString(
            settingsPath,
            JSON.stringify({
              defaultProvider: "antigravity",
              enabledModels: [
                "opencode-go/deepseek-v4.1-flash",
                "antigravity/gemini-4-hydrogen:high",
              ],
            }),
          );

          let serverSettings: ServerSettings = {
            ...DEFAULT_SERVER_SETTINGS,
            providerModelPreferences: {
              [instanceId]: {
                hiddenModels: ["default"],
                modelOrder: [],
              },
            },
          };

          const pulled = yield* reconcilePiScopedModels({
            instanceId,
            environment: { PI_CODING_AGENT_DIR: agentDir },
            discoveredModels: catalog,
            getSettings: Effect.sync(() => serverSettings),
            updateSettings: (patch) =>
              Effect.sync(() => {
                serverSettings = { ...serverSettings, ...patch };
                return serverSettings;
              }),
            direction: "from-pi",
          });

          assert.isTrue(pulled);
          assert.deepEqual(serverSettings.providerModelPreferences?.[instanceId], {
            hiddenModels: [
              "default",
              "claude-subscription-hfpetch/claude-opus-5-5",
              "openrouter/google/gemini-4-neon",
              "openrouter/google/gemini-4-neon:batch",
            ],
            modelOrder: ["opencode-go/deepseek-v4.1-flash", "antigravity/gemini-4-hydrogen"],
          });

          // Toggling a model on in T3 and reordering writes back to Pi's settings.json.
          serverSettings = {
            ...serverSettings,
            providerModelPreferences: {
              [instanceId]: {
                hiddenModels: [
                  "default",
                  "openrouter/google/gemini-4-neon",
                  "openrouter/google/gemini-4-neon:batch",
                ],
                modelOrder: [
                  "claude-subscription-hfpetch/claude-opus-5-5",
                  "antigravity/gemini-4-hydrogen",
                  "opencode-go/deepseek-v4.1-flash",
                ],
              },
            },
          };

          const pushed = yield* reconcilePiScopedModels({
            instanceId,
            environment: { PI_CODING_AGENT_DIR: agentDir },
            discoveredModels: catalog,
            getSettings: Effect.sync(() => serverSettings),
            direction: "to-pi",
          });

          assert.isTrue(pushed);
          const rawAfter = yield* fileSystem.readFileString(settingsPath);
          assert.deepEqual(parsePiEnabledModels(rawAfter), [
            "claude-subscription-hfpetch/claude-opus-5-5",
            "antigravity/gemini-4-hydrogen:high",
            "opencode-go/deepseek-v4.1-flash",
          ]);
          assert.equal(JSON.parse(rawAfter).defaultProvider, "antigravity");

          // Writing the same state again is a no-op.
          assert.isFalse(
            yield* writePiEnabledModels({
              agentDir,
              enabledModels: parsePiEnabledModels(rawAfter),
            }),
          );
        }),
      ),
  );
});
