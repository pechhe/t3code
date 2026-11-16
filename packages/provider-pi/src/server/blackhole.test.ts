// @effect-diagnostics nodeBuiltinImport:off
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";

import {
  piBlackholeCompactionThreshold,
  readPiBlackholeConfig,
  syncPiBlackholeModel,
} from "./blackhole.ts";

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

describe("piBlackholeCompactionThreshold", () => {
  const auto = { compaction: "auto", compactionEngine: "blackhole" };
  it.each([
    { name: "the default curve at its last anchor", config: auto, window: 1_048_576, at: 419_430 },
    { name: "the default curve between anchors", config: auto, window: 196_608, at: 147_456 },
    { name: "the default curve below its first anchor", config: auto, window: 16_000, at: 14_400 },
    {
      name: "a fixed point over every other knob",
      config: { ...auto, compactAfterTokens: 120_000, compactAfterRatio: 0.5 },
      window: 1_000_000,
      at: 120_000,
    },
    {
      name: "a share of the window, ignoring the retired 81000 default",
      config: { ...auto, compactAfterTokens: 81_000, compactAfterRatio: 0.5 },
      window: 200_000,
      at: 100_000,
    },
    {
      name: "a reserve below the window",
      config: { ...auto, compactAfterRatio: 0, compactReserveTokens: 30_000 },
      window: 200_000,
      at: 170_000,
    },
    {
      name: "the user's own curve",
      config: {
        ...auto,
        compactAfterPreset: "early",
        compactAfterPresets: { early: [{ window: 100_000, ratio: 0.25 }] },
      },
      window: 400_000,
      at: 100_000,
    },
    {
      name: "the default curve for an unknown preset",
      config: { ...auto, compactAfterPreset: "missing" },
      window: 32_768,
      at: 29_491,
    },
    {
      name: "nothing when compaction is manual",
      config: { ...auto, compaction: "manual" },
      at: null,
    },
    {
      name: "nothing when Pi's own engine compacts",
      config: { compaction: "auto", compactionEngine: "pi-default" },
      at: null,
    },
    { name: "nothing for a legacy passive config", config: { passive: true }, at: null },
  ])("reports $name", ({ config, window = 200_000, at }) => {
    assert.equal(piBlackholeCompactionThreshold(config, window), at);
  });
});

describe("readPiBlackholeConfig", () => {
  it.effect("lays the project's config over the agent directory's", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const agentDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-blackhole-" });
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-project-" });
      assert.equal(yield* readPiBlackholeConfig(agentDir, cwd), null);
      yield* fileSystem.makeDirectory(NodePath.join(agentDir, "pi-blackhole"));
      yield* fileSystem.writeFileString(
        NodePath.join(agentDir, "pi-blackhole", "pi-blackhole-config.json"),
        JSON.stringify({ compaction: "auto", compactAfterPreset: "default" }),
      );
      const own = yield* readPiBlackholeConfig(agentDir, cwd);
      assert.equal(own && piBlackholeCompactionThreshold(own, 1_048_576), 419_430);
      yield* fileSystem.makeDirectory(NodePath.join(cwd, ".pi"));
      yield* fileSystem.writeFileString(
        NodePath.join(cwd, ".pi", "pi-blackhole-config.json"),
        JSON.stringify({ compactAfterRatio: 0.5 }),
      );
      const merged = yield* readPiBlackholeConfig(agentDir, cwd);
      assert.equal(merged && piBlackholeCompactionThreshold(merged, 200_000), 100_000);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.orDie),
  );
});
