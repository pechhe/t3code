import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CodexSettings, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as ProcessGroupLedger from "@t3tools/provider-core/server/ProcessGroupLedger";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

describe.skipIf(process.platform === "win32")("Codex process groups", () => {
  it.effect("keeps app-server stdio working in a recorded group and forgets it on exit", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mock = path.resolve(
        import.meta.dirname,
        "../../../../../packages/effect-codex-app-server/test/fixtures/codex-app-server-mock-peer.ts",
      );
      const forgotten = yield* Deferred.make<void>();
      const recorded = yield* Deferred.make<number>();
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const ledger = yield* ProcessGroupLedger.make({ stateDir });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const factory = yield* CodexAdapterV2.CodexAppServerClientFactory.pipe(
            Effect.provide(CodexAdapterV2.layerAppServerClientFactory),
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((command) => {
                if (!ChildProcess.isStandardCommand(command)) return spawner.spawn(command);
                return spawner.spawn(ChildProcess.make(process.execPath, [mock], command.options));
              }),
            ),
            Effect.provideService(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
            Effect.provideService(ProcessGroupLedger.ProcessGroupLedger, {
              track: ({ pid, args }) =>
                Effect.gen(function* () {
                  assert.include(args, "app-server");
                  const forget = yield* ledger.track({ pid, args });
                  yield* Deferred.succeed(recorded, pid);
                  return forget.pipe(
                    Effect.andThen(Deferred.succeed(forgotten, undefined)),
                    Effect.asVoid,
                  );
                }),
            }),
          );
          const client = yield* factory.open({
            instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
            threadId: ThreadId.make("ledger-test"),
            providerSessionId: ProviderSessionId.make("ledger-test"),
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: null,
            }),
            settings: yield* Schema.decodeEffect(CodexSettings)({}),
            environment: {},
          });
          const initialized = yield* client.request("initialize", {
            clientInfo: { name: "ledger-test", title: null, version: "0.0.0" },
            capabilities: { experimentalApi: true, optOutNotificationMethods: null },
          });
          assert.equal(initialized.userAgent, "mock-codex-app-server");
          const group = yield* Deferred.await(recorded);
          assert.doesNotThrow(() => process.kill(-group, 0));
          assert.deepEqual(yield* fs.readDirectory(path.join(stateDir, "provider-processes")), [
            `${group}.json`,
          ]);
        }),
      );
      yield* Deferred.await(forgotten);
      assert.deepEqual(yield* fs.readDirectory(path.join(stateDir, "provider-processes")), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
