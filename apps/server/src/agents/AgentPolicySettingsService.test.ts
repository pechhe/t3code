import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AgentPolicyManifest } from "@t3tools/contracts";
import * as Settings from "./AgentPolicySettingsService.ts";
import * as ServerSettings from "../serverSettings.ts";
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
  const catalog = ["codex", "claudeAgent"].map((driver) =>
    provider(
      driver,
      `${driver}-test`,
      Object.values(manifest.models)
        .filter((binding) => binding.driverKind === driver)
        .map((binding) => binding.model),
    ),
  );
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
  it.effect(
    "previews trusted writer, restricted child, sandbox requirement and reader boundaries",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.run(
          Effect.gen(function* () {
            const settings = yield* ServerSettings.ServerSettingsService;
            const policy = yield* Settings.AgentPolicySettingsService;
            const preview = (overrides: Partial<Parameters<typeof policy.preview>[0]> = {}) =>
              policy.preview({
                manifest: f.manifest,
                role: "ui-worker",
                taskClass: "ui",
                ...overrides,
              });
            expect((yield* preview()).refusal).toBe("no-eligible-model");
            yield* settings.updateSettings({ delegation: { allowTrustedClaudeWriters: true } });
            const writer = yield* preview();
            expect(writer.executionRequirement).toBe("trusted-host-allowed");
            expect(writer.executionBoundary).toBe("trusted-host-access");
            expect((yield* preview({ executionRequirement: "sandbox-required" })).refusal).toBe(
              "no-eligible-model",
            );
            expect((yield* preview({ runtimeMode: "auto" })).refusal).toBe("no-eligible-model");
            const reader = yield* preview({ role: "advisor", taskClass: "non-ui" });
            expect(reader.executionRequirement).toBe("sandbox-required");
            expect(reader.executionBoundary).toBe("read-only");
          }),
        );
      }).pipe(Effect.provide(ServerSettings.layerTest())),
  );

  it.effect("reads source status and previews the real selection without changing policy", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const before = yield* fs.readFileString(`${f.root}/roles/policy.json`);
      const result = yield* f.run(
        Effect.gen(function* () {
          const settings = yield* Settings.AgentPolicySettingsService;
          const read = yield* settings.read();
          const preview = yield* settings.preview({
            manifest: f.manifest,
            role: "implementation-worker",
            taskClass: "non-ui",
          });
          return { read, preview };
        }),
      );
      expect(result.read.sourceRoot).toBe(f.root);
      expect(result.read.providers).toEqual(f.catalog);
      expect(result.read.uncommitted).toBeNull();
      expect(result.preview.selection?.model).toBe(f.manifest.models.sol?.model);
      expect(result.preview.candidates).toContainEqual(
        expect.objectContaining({ alias: "sol", reason: "selected" }),
      );
      expect(yield* fs.readFileString(`${f.root}/roles/policy.json`)).toBe(before);
    }),
  );
  it.effect("saves supported choices and the next preview uses the new policy", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.run(
        Effect.gen(function* () {
          const settings = yield* Settings.AgentPolicySettingsService;
          const first = yield* settings.read();
          const manifest = {
            ...f.manifest,
            pools: {
              ...f.manifest.pools,
              workhorse: {
                ...f.manifest.pools.workhorse,
                prefer: ["sol", "sonnet"],
                crossProvider: false,
              },
            },
          };
          const saved = yield* settings.save({ expectedHash: first.snapshot.hash, manifest });
          const preview = yield* settings.preview({
            manifest: saved.snapshot.manifest,
            role: "reviewer",
            taskClass: "non-ui",
          });
          return { first, saved, preview };
        }),
      );
      expect(result.saved.snapshot.hash).not.toBe(result.first.snapshot.hash);
      expect(result.preview.selection?.model).toBe(f.manifest.models.sol?.model);
      expect(result.first.snapshot.manifest.pools.workhorse.prefer).toEqual(["sonnet", "sol"]);
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
          expect(
            (yield* settings
              .save({ expectedHash: "0".repeat(64), manifest: f.manifest })
              .pipe(Effect.flip)).reason,
          ).toBe("stale");
          const unknown = {
            ...f.manifest,
            models: {
              ...f.manifest.models,
              sol: { ...f.manifest.models.sol!, model: "uninstalled-model" },
            },
          };
          expect(
            (yield* settings
              .save({ expectedHash: first.snapshot.hash, manifest: unknown })
              .pipe(Effect.flip)).reason,
          ).toBe("unsupported-model");
          const badEffort = {
            ...f.manifest,
            roles: {
              ...f.manifest.roles,
              "implementation-worker": {
                ...f.manifest.roles["implementation-worker"],
                effort: {
                  ...f.manifest.roles["implementation-worker"].effort,
                  sol: { default: "unsupported-effort" },
                },
              },
            },
          };
          expect(
            (yield* settings
              .save({ expectedHash: first.snapshot.hash, manifest: badEffort })
              .pipe(Effect.flip)).reason,
          ).toBe("unsupported-model");
        }),
      );
      expect(yield* fs.readFileString(`${f.root}/roles/policy.json`)).toBe(before);
    }),
  );
});
