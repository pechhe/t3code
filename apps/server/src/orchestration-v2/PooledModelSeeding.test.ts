import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import { roleModels, seedPooledModelKeysOnce } from "./PooledModelSeeding.ts";

const NOW = "2026-11-19T09:00:00.000Z";

const provider = (
  id: string,
  driver: string,
  models: ReadonlyArray<readonly [slug: string, name: string]>,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(driver),
  displayName: id,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: models.map(([slug, name]) => ({ slug, name, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
});

const providers = [
  provider("claude-yardsmith", "claudeAgent", [["claude-opus-5-5", "Claude Opus 5.5"]]),
  provider("claude-hfpetch", "claudeAgent", [
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ]),
  provider("codex", "codex", [["gpt-6.2-sol", "GPT-6.2 Sol"]]),
  provider("codex-work", "codex", [["gpt-6.2-sol", "GPT-6.2 Sol"]]),
];

describe("seeding the pooled models", () => {
  it.effect("pools his favorites and role models once, then leaves his list alone", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const roles = () =>
        Effect.succeed([{ driver: ProviderDriverKind.make("codex"), model: "gpt-6.2-sol" }]);
      assert.isTrue(yield* seedPooledModelKeysOnce({ settings, providers, roles }));
      assert.deepEqual((yield* settings.getSettings).pooledModelKeys, [
        "claude-opus-5-5",
        "gpt-6-2-sol",
      ]);

      // Even a list he emptied is his: seeding neither refills it nor reads his roles again.
      yield* settings.updateSettings({ pooledModelKeys: [] });
      assert.isFalse(
        yield* seedPooledModelKeysOnce({
          settings,
          providers,
          roles: () => Effect.die("the roles are not read once the list is written"),
        }),
      );
      assert.deepEqual((yield* settings.getSettings).pooledModelKeys, []);
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          favorites: [
            { provider: ProviderInstanceId.make("claude-yardsmith"), model: "claude-opus-5-5" },
          ],
        }),
      ),
    ),
  );
});

describe("the models a policy's roles use", () => {
  it("are the models its role lists name, not every model it defines", () => {
    const codex = ProviderDriverKind.make("codex");
    assert.deepEqual(
      roleModels({
        models: {
          sol: { driverKind: codex, model: "gpt-6.2-sol" },
          unused: { driverKind: codex, model: "gpt-6-astra" },
        },
        lists: { implementer: [{ model: "sol" }], reviewer: [{ model: "sol" }] },
      }),
      [
        { driver: codex, model: "gpt-6.2-sol" },
        { driver: codex, model: "gpt-6.2-sol" },
      ],
    );
  });
});
