import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import * as ServerSettingsModule from "./serverSettings.ts";
import { withAliasesAdded } from "./sharedProviderSetup.ts";

const testLayer = ServerSettingsModule.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-shared-setup-test-" })),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const id = (value: string) => ProviderInstanceId.make(value);
const instances = (map: Record<string, unknown>) => map as unknown as ProviderInstanceConfigMap;

const sharedService = Effect.gen(function* () {
  const service = yield* ServerSettingsModule.ServerSettingsService;
  yield* service.start;
  yield* service.setProviderSetupSharing(true);
  return service;
});

const stateOf = (settings: { readonly sharedProviderSetup?: unknown }) =>
  settings.sharedProviderSetup as {
    readonly shared: boolean;
    readonly version: number;
    readonly baseVersion: number;
    readonly digest: string;
  };

it.describe("shared provider setup", () => {
  it("keeps an earlier alias pointing at a live instance when a later join renames it again", () => {
    const w = ProviderInstanceId.make("claudeAgent_w");
    const x = ProviderInstanceId.make("claudeAgent_x");
    const y = ProviderInstanceId.make("claudeAgent_y");
    assert.deepStrictEqual(withAliasesAdded({ [w]: x }, new Map([[x, y]])), { [w]: y, [x]: y });
  });

  it.effect("counts each edit once on a shared machine and none on an unshared one", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* service.start;
      const unshared = yield* service.updateProviderInstance({
        operation: "upsert",
        instanceId: id("codex_a"),
        instance: { driver: codex, displayName: "A" },
      });
      assert.isUndefined(unshared.sharedProviderSetup);

      const shared = yield* service.setProviderSetupSharing(true);
      const { version } = stateOf(shared);
      const edited = yield* service.updateProviderInstance({
        operation: "upsert",
        instanceId: id("codex_a"),
        instance: { driver: codex, displayName: "B" },
      });
      assert.equal(stateOf(edited).version, version + 1);
      assert.equal(stateOf(edited).baseVersion, version);

      const unrelated = yield* service.updateSettings({ defaultThreadEnvMode: "local" });
      assert.equal(stateOf(unrelated).version, version + 1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("records a received setup without counting it as an edit, so it can't echo", () =>
    Effect.gen(function* () {
      const service = yield* sharedService;
      const before = yield* service.getSettings;
      const applied = yield* service.applySharedProviderSetup({
        instances: instances({ codex_a: { driver: codex, displayName: "From elsewhere" } }),
        version: 7,
        changedAt: "2026-11-09T10:00:00.000Z",
        expectedDigest: stateOf(before).digest,
        join: false,
      });
      assert.equal(stateOf(applied).version, 7);
      assert.equal(stateOf(applied).baseVersion, 7);
      assert.equal(applied.providerInstances[id("codex_a")]?.displayName, "From elsewhere");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses a setup planned against a state this machine has moved past", () =>
    Effect.gen(function* () {
      const service = yield* sharedService;
      const planned = yield* service.getSettings;
      yield* service.updateProviderInstance({
        operation: "upsert",
        instanceId: id("codex_a"),
        instance: { driver: codex },
      });
      const error = yield* Effect.flip(
        service.applySharedProviderSetup({
          instances: instances({}),
          version: 9,
          changedAt: "2026-11-09T10:00:00.000Z",
          expectedDigest: stateOf(planned).digest,
          join: false,
        }),
      );
      assert.equal(error.operation, "apply-shared-provider-setup");
      assert.isDefined((yield* service.getSettings).providerInstances[id("codex_a")]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses a shared change on a machine that stopped sharing", () =>
    Effect.gen(function* () {
      const service = yield* sharedService;
      const left = yield* service.setProviderSetupSharing(false);
      const error = yield* Effect.flip(
        service.applySharedProviderSetup({
          instances: instances({}),
          version: 9,
          changedAt: "2026-11-09T10:00:00.000Z",
          expectedDigest: stateOf(left).digest,
          join: false,
        }),
      );
      assert.equal(error.operation, "apply-shared-provider-setup");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps this machine's secret when a setup arrives, and never stores another's", () =>
    Effect.gen(function* () {
      const service = yield* sharedService;
      const store = yield* ServerSecretStore.ServerSecretStore;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const local = yield* service.updateProviderInstance({
        operation: "upsert",
        instanceId: id("codex_a"),
        instance: {
          driver: codex,
          environment: [{ name: "API_TOKEN", value: "local-secret", sensitive: true }],
        },
      });
      const applied = yield* service.applySharedProviderSetup({
        instances: instances({
          codex_a: {
            driver: codex,
            displayName: "Renamed",
            environment: [{ name: "API_TOKEN", value: "", sensitive: true }],
          },
        }),
        version: 7,
        changedAt: "2026-11-09T10:00:00.000Z",
        expectedDigest: stateOf(local).digest,
        join: false,
      });
      assert.equal(applied.providerInstances[id("codex_a")]?.displayName, "Renamed");
      assert.equal(
        applied.providerInstances[id("codex_a")]?.environment?.[0]?.value,
        "local-secret",
      );
      assert.notInclude(yield* fs.readFileString(config.settingsPath), "local-secret");
      const names = yield* store.get("provider-env-codex_a-API_TOKEN").pipe(Effect.option);
      assert.isTrue(Option.isSome(names));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "gives a joining machine's account the shared id and keeps what named the old one",
    () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsModule.ServerSettingsService;
        yield* service.start;
        const homePath = "~/.claude-accounts/pool-1";
        yield* service.updateSettings({
          providerInstances: {
            [id("claudeAgent_pool1")]: {
              driver: claude,
              config: { homePath },
              environment: [{ name: "API_TOKEN", value: "kept", sensitive: true }],
            },
            [id("only_here")]: { driver: codex },
          },
          textGenerationModelSelection: { instanceId: id("claudeAgent_pool1"), model: "m" },
        });
        const joined = yield* service.applySharedProviderSetup({
          instances: instances({
            claudeAgent_claude_ys: {
              driver: claude,
              config: { homePath },
              environment: [{ name: "API_TOKEN", value: "", sensitive: true }],
            },
            claude_pool: {
              driver: claude,
              pool: ["claudeAgent_claude_ys", "claudeAgent_claude_hello"],
              preferredMember: "claudeAgent_claude_hello",
            },
          }),
          version: 3,
          changedAt: "2026-11-09T10:00:00.000Z",
          expectedDigest: "",
          join: true,
        });
        assert.isTrue(stateOf(joined).shared);
        assert.isUndefined(joined.providerInstances[id("only_here")]);
        assert.deepEqual(joined.providerInstanceAliases, {
          [id("claudeAgent_pool1")]: id("claudeAgent_claude_ys"),
        });
        assert.equal(joined.textGenerationModelSelection?.instanceId, id("claudeAgent_claude_ys"));
        assert.equal(
          joined.providerInstances[id("claudeAgent_claude_ys")]?.environment?.[0]?.value,
          "kept",
        );
        const pool = joined.providerInstances[id("claude_pool")];
        assert.deepEqual(pool?.pool, [id("claudeAgent_claude_ys")]);
        assert.isUndefined(pool?.preferredMember);
      }).pipe(Effect.provide(testLayer)),
  );

  const startWith = (file: unknown) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(config.settingsPath, JSON.stringify(file));
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* service.start;
      return yield* service.getSettings;
    });
  const sharedAt = (version: number, digest: string) => ({
    shared: true,
    version,
    baseVersion: version,
    changedAt: "2026-11-09T09:00:00.000Z",
    digest,
  });

  it.effect(
    "keeps a removed provider out, and pool fields, when a client writes its older list",
    () =>
      Effect.gen(function* () {
        const service = yield* sharedService;
        const stale = (yield* service.updateProviderInstance({
          operation: "upsert",
          instanceId: id("codex_extra"),
          instance: { driver: codex },
        })).providerInstances;
        yield* service.updateProviderInstance({
          operation: "remove",
          instanceId: id("codex_extra"),
        });

        const written = yield* service.updateSettings({ providerInstances: stale });
        assert.isFalse(Object.hasOwn(written.providerInstances, "codex_extra"));

        const pooled = yield* service.updateProviderInstance({
          operation: "upsert",
          instanceId: id("claude_pool"),
          instance: {
            driver: claude,
            pool: [id("claudeAgent")],
            preferredMember: id("claudeAgent"),
          },
        });
        const { preferredMember: _unknownToOlderClients, ...olderCopy } =
          pooled.providerInstances[id("claude_pool")]!;
        const kept = yield* service.updateSettings({
          providerInstances: { ...pooled.providerInstances, [id("claude_pool")]: olderCopy },
        });
        assert.equal(kept.providerInstances[id("claude_pool")]?.preferredMember, "claudeAgent");

        const readded = yield* service.updateProviderInstance({
          operation: "upsert",
          instanceId: id("codex_extra"),
          instance: { driver: codex },
        });
        assert.isTrue(Object.hasOwn(readded.providerInstances, "codex_extra"));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("treats a provider edited by hand in the settings file as an edit", () =>
    Effect.gen(function* () {
      const settings = yield* startWith({
        providerInstances: { codex_hand: { driver: "codex" } },
        sharedProviderSetup: sharedAt(4, "digest-before-the-hand-edit"),
      });
      assert.equal(stateOf(settings).version, 5);
      assert.equal(stateOf(settings).baseVersion, 4);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("remembers a provider removed by hand, so an older list can't bring it back", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const state = sharedAt(4, "digest");
      const both = { codex_kept: { driver: "codex" }, codex_gone: { driver: "codex" } };
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ providerInstances: both, sharedProviderSetup: state }),
      );
      const stale = (yield* service.getSettings).providerInstances;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          providerInstances: { codex_kept: both.codex_kept },
          sharedProviderSetup: state,
        }),
      );
      yield* service.start;

      const written = yield* service.updateSettings({ providerInstances: stale });
      assert.isFalse(Object.hasOwn(written.providerInstances, "codex_gone"));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reports a secret the setup expects that this machine doesn't hold", () =>
    Effect.gen(function* () {
      const settings = yield* startWith({
        providerInstances: {
          opencode: {
            driver: "opencode",
            environment: [
              { name: "OPENCODE_API_KEY", value: "", sensitive: true, valueRedacted: true },
            ],
          },
        },
        sharedProviderSetup: sharedAt(4, ""),
      });
      assert.deepEqual(settings.sharedProviderSetup?.missingSecrets, {
        opencode: ["OPENCODE_API_KEY"],
      });

      const service = yield* ServerSettingsModule.ServerSettingsService;
      const instance = {
        driver: ProviderDriverKind.make("opencode"),
        environment: [{ name: "OPENCODE_API_KEY", value: "added-here", sensitive: true }],
      };
      const added = yield* service.updateProviderInstance({
        operation: "upsert",
        instanceId: id("opencode"),
        instance,
      });
      assert.deepEqual(added.sharedProviderSetup?.missingSecrets, {});
      assert.equal(stateOf(added).version, stateOf(settings).version);
    }).pipe(Effect.provide(testLayer)),
  );
});
