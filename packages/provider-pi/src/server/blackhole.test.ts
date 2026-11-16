// @effect-diagnostics nodeBuiltinImport:off
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";

import { syncPiBlackholeModel } from "./blackhole.ts";

const ownModel = { provider: "openai-codex", id: "gpt-6-luna", thinking: "low" };

describe("syncPiBlackholeModel", () => {
  const withConfig = <A, E>(
    initial: Record<string, unknown> | undefined,
    use: (
      agentDir: string,
      readConfig: Effect.Effect<Record<string, unknown>>,
    ) => Effect.Effect<A, E, FileSystem.FileSystem>,
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const agentDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-blackhole-" });
      const configPath = NodePath.join(agentDir, "pi-blackhole", "pi-blackhole-config.json");
      if (initial !== undefined) {
        yield* fileSystem.makeDirectory(NodePath.dirname(configPath), { recursive: true });
        yield* fileSystem.writeFileString(configPath, JSON.stringify(initial));
      }
      const readConfig = fileSystem.readFileString(configPath).pipe(
        Effect.map((text) => JSON.parse(text) as Record<string, unknown>),
        Effect.orDie,
      );
      return yield* use(agentDir, readConfig);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.orDie);

  it.effect("leaves an agent directory without Pi Blackhole alone", () =>
    withConfig(undefined, (agentDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const wrote = yield* syncPiBlackholeModel({
          agentDir,
          model: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
        });
        assert.equal(wrote, false);
        assert.equal(yield* fileSystem.exists(NodePath.join(agentDir, "pi-blackhole")), false);
      }),
    ),
  );

  it.effect("writes the model, keeps its other keys, and restores the original when cleared", () =>
    withConfig({ debug: false, model: ownModel, compaction: "auto" }, (agentDir, readConfig) =>
      Effect.gen(function* () {
        const model = { provider: "opencode-go", id: "deepseek-v4.1-flash" };
        assert.equal(yield* syncPiBlackholeModel({ agentDir, model }), true);
        const written = yield* readConfig;
        assert.deepEqual(written["model"], { ...model, thinking: "low" });
        assert.equal(written["compaction"], "auto");
        assert.equal(yield* syncPiBlackholeModel({ agentDir, model }), false);

        assert.equal(
          yield* syncPiBlackholeModel({ agentDir, model: { ...model, thinking: "high" } }),
          true,
        );
        assert.equal(yield* syncPiBlackholeModel({ agentDir, model: null }), true);
        assert.deepEqual(yield* readConfig, { debug: false, model: ownModel, compaction: "auto" });
        assert.equal(yield* syncPiBlackholeModel({ agentDir, model: null }), false);
      }),
    ),
  );

  it.effect("restores after the config is rewritten with the same model in another key order", () =>
    withConfig({ model: ownModel }, (agentDir, readConfig) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* syncPiBlackholeModel({ agentDir, model: { provider: "a", id: "b" } });
        yield* fileSystem.writeFileString(
          NodePath.join(agentDir, "pi-blackhole", "pi-blackhole-config.json"),
          JSON.stringify({ model: { thinking: "low", id: "b", provider: "a" } }),
        );
        assert.equal(yield* syncPiBlackholeModel({ agentDir, model: null }), true);
        assert.deepEqual((yield* readConfig)["model"], ownModel);
      }),
    ),
  );

  it.effect("does not carry a thinking level T3 wrote over to the next model", () =>
    withConfig({ model: ownModel }, (agentDir, readConfig) =>
      Effect.gen(function* () {
        yield* syncPiBlackholeModel({
          agentDir,
          model: { provider: "a", id: "b", thinking: "max" },
        });
        yield* syncPiBlackholeModel({ agentDir, model: { provider: "c", id: "d" } });
        assert.deepEqual((yield* readConfig)["model"], { provider: "c", id: "d", thinking: "low" });
      }),
    ),
  );

  it.effect("removes a model T3 added to a config that had none", () =>
    withConfig({ debug: false }, (agentDir, readConfig) =>
      Effect.gen(function* () {
        yield* syncPiBlackholeModel({ agentDir, model: { provider: "a", id: "b" } });
        yield* syncPiBlackholeModel({ agentDir, model: null });
        assert.deepEqual(yield* readConfig, { debug: false });
      }),
    ),
  );

  it.effect("keeps a model someone set after T3 wrote its own", () =>
    withConfig({ model: ownModel }, (agentDir, readConfig) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* syncPiBlackholeModel({ agentDir, model: { provider: "a", id: "b" } });
        const theirs = { provider: "c", id: "d" };
        yield* fileSystem.writeFileString(
          NodePath.join(agentDir, "pi-blackhole", "pi-blackhole-config.json"),
          JSON.stringify({ model: theirs }),
        );
        assert.equal(yield* syncPiBlackholeModel({ agentDir, model: null }), false);
        assert.deepEqual((yield* readConfig)["model"], theirs);
      }),
    ),
  );
});
