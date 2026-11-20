import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ManagedPolicyDocument, ServerSettings } from "@t3tools/contracts";

import { assert, it } from "@effect/vitest";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";

import * as Schema from "effect/Schema";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";

import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";

import * as ServerSettingsModule from "./serverSettings.ts";

import * as ManagedPolicy from "./policy/ManagedPolicy.ts";

const decodeServerSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));

const layerServerSettings = (policy?: ManagedPolicyDocument) =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ManagedPolicy.layerTest(policy)),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

it.effect("persists delegation runtime settings and preserves existing defaults", () =>
  Effect.gen(function* () {
    const service = yield* ServerSettingsModule.ServerSettingsService;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* service.start;
    assert.deepEqual((yield* service.getSettings).delegation, {
      defaultChildRuntimeMode: "inherit",
      advisorIdleCloseMinutes: null,
      allowTrustedClaudeWriters: false,
      modelShadow: false,
    });
    const delegation = {
      defaultChildRuntimeMode: "approval-required" as const,
      advisorIdleCloseMinutes: 15,
      allowTrustedClaudeWriters: true,
      modelShadow: true,
    };
    yield* service.updateSettings({ delegation });
    // An old client editing its known fields cannot reset the owner's explicit opt-in.
    yield* service.updateSettings({ delegation: { advisorIdleCloseMinutes: 15 } });
    const persisted = yield* decodeServerSettingsJson(
      yield* fs.readFileString(config.settingsPath),
    );
    assert.deepEqual(persisted.delegation, delegation);
    const restored = yield* Effect.gen(function* () {
      const restarted = yield* ServerSettingsModule.ServerSettingsService;
      yield* restarted.start;
      return yield* restarted.getSettings;
    }).pipe(
      Effect.provide(
        Layer.fresh(ServerSettingsModule.layer).pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(ManagedPolicy.layerTest()),
        ),
      ),
    );
    assert.deepEqual(restored.delegation, delegation);
  }).pipe(
    Effect.provide(
      layerServerSettings().pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
