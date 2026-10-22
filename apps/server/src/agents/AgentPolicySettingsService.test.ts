import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AgentPolicyManifest } from "@t3tools/contracts";
import * as Settings from "./AgentPolicySettingsService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import { snapshot, provider } from "./agentPolicy.testkit.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(AgentPolicyManifest));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "policy-settings-test-" });
  yield* fs.makeDirectory(`${root}/roles`);
  const manifest = snapshot().manifest;
  yield* fs.writeFileString(`${root}/roles/policy.json`, encode(manifest));
  for (const role of Object.values(manifest.roles))
    yield* fs.writeFileString(`${root}/${role.brief}`, `Brief: ${role.brief}\n`);
  const catalog = [
    ...["codex", "claudeAgent"].map((driver) =>
      provider(
        driver,
        `${driver}-test`,
        Object.values(manifest.models)
          .filter((binding) => binding.driverKind === driver)
          .map((binding) => binding.model),
      ),
    ),
    {
      ...provider("pi", "pi-test", []),
      models: [
        {
          slug: "deepseek-v4",
          name: "DeepSeek V4.1 Flash",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
      ],
    },
  ];
  const layer = Settings.layer.pipe(
    Layer.provide(
      Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed(catalog) }),
    ),
  );
  return {
    root,
    manifest,
    catalog,
    run: <A, E, R>(effect: Effect.Effect<A, E, Settings.AgentPolicySettingsService | R>) =>
      effect.pipe(
        Effect.provide(Layer.fresh(layer)),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ T3CODE_AGENT_POLICY_ROOT: root }),
        ),
      ),
  };
});

it.layer(NodeServices.layer)("policy settings", (it) => {
  it.effect("reads source status and the installed catalog without changing policy", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const before = yield* fs.readFileString(`${f.root}/roles/policy.json`);
      const read = yield* f.run(
        Effect.gen(function* () {
          return yield* (yield* Settings.AgentPolicySettingsService).read();
        }),
      );
      expect(read.sourceRoot).toBe(f.root);
      expect(read.providers).toEqual(f.catalog);
      expect(read.uncommitted).toBeNull();
      expect(yield* fs.readFileString(`${f.root}/roles/policy.json`)).toBe(before);
    }),
  );
  it.effect("saves supported choices and reads them back", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.run(
        Effect.gen(function* () {
          const settings = yield* Settings.AgentPolicySettingsService;
          const first = yield* settings.read();
          const manifest = {
            ...f.manifest,
            lists: {
              ...f.manifest.lists,
              workhorse: [
                { model: "sol", effort: "medium" },
                { model: "sonnet", effort: "high" },
              ],
            },
          };
          const saved = yield* settings.save({ expectedHash: first.snapshot.hash, manifest });
          return { first, saved };
        }),
      );
      expect(result.saved.snapshot.hash).not.toBe(result.first.snapshot.hash);
      expect(result.saved.snapshot.manifest.lists["workhorse"]?.map((e) => e.model)).toEqual([
        "sol",
        "sonnet",
      ]);
    }),
  );
  it.effect("saves a model from any installed provider, with or without an effort setting", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const saved = yield* f.run(
        Effect.gen(function* () {
          const settings = yield* Settings.AgentPolicySettingsService;
          const first = yield* settings.read();
          const manifest = yield* Schema.decodeUnknownEffect(AgentPolicyManifest)({
            ...f.manifest,
            models: {
              ...f.manifest.models,
              deepseek: { driverKind: "pi", model: "deepseek-v4" },
            },
            lists: {
              ...f.manifest.lists,
              workhorse: [...f.manifest.lists["workhorse"]!, { model: "deepseek" }],
            },
          });
          return yield* settings.save({ expectedHash: first.snapshot.hash, manifest });
        }),
      );
      expect(saved.snapshot.manifest.models["deepseek"]).toEqual({
        driverKind: "pi",
        model: "deepseek-v4",
      });
      expect(saved.snapshot.manifest.lists["workhorse"]?.at(-1)).toEqual({ model: "deepseek" });
    }),
  );
  it.effect("refuses stale saves, unsupported models and unsupported effort without writing", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const before = yield* fs.readFileString(`${f.root}/roles/policy.json`);
      yield* f.run(
        Effect.gen(function* () {
          const settings = yield* Settings.AgentPolicySettingsService;
          const first = yield* settings.read();
          const refused = (manifest: typeof f.manifest) =>
            settings.save({ expectedHash: first.snapshot.hash, manifest }).pipe(
              Effect.flip,
              Effect.map((error) => error.reason),
            );
          expect(
            (yield* settings
              .save({ expectedHash: "0".repeat(64), manifest: f.manifest })
              .pipe(Effect.flip)).reason,
          ).toBe("stale");
          expect(
            yield* refused({
              ...f.manifest,
              models: {
                ...f.manifest.models,
                sol: { ...f.manifest.models.sol!, model: "uninstalled-model" },
              },
            }),
          ).toBe("unsupported-model");
          expect(
            yield* refused({
              ...f.manifest,
              lists: { ...f.manifest.lists, workhorse: [{ model: "sol", effort: "unsupported" }] },
            }),
          ).toBe("unsupported-model");
          // A large-task effort is checked like a list effort.
          expect(
            yield* refused({
              ...f.manifest,
              roles: {
                ...f.manifest.roles,
                "implementation-worker": {
                  ...f.manifest.roles["implementation-worker"],
                  large: { model: "sol", effort: "unsupported" },
                },
              },
            }),
          ).toBe("unsupported-model");
        }),
      );
      expect(yield* fs.readFileString(`${f.root}/roles/policy.json`)).toBe(before);
    }),
  );
});
