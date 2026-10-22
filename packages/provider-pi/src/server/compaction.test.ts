// @effect-diagnostics nodeBuiltinImport:off
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";

import {
  PI_COMPACTION_OWNERSHIP_FILENAME,
  PI_DEFAULT_COMPACTION_RESERVE_TOKENS,
  decodePiCompactionSettings,
  parsePiCompactionSettings,
  piAgentDirectory,
  piCompactionReserve,
  piCompactionReserveForPoint,
  piCompactionThreshold,
  syncPiCompactionPoint,
} from "./compaction.ts";

const modelKey = "opencode-go/deepseek-v4.1-flash";

describe("Pi compaction settings", () => {
  it("keeps Pi's defaults when the file has no compaction block", () => {
    const settings = parsePiCompactionSettings('{"lastChangelogVersion":"1.4.0"}');
    assert.equal(settings.reserveTokens, PI_DEFAULT_COMPACTION_RESERVE_TOKENS);
    assert.equal(piCompactionReserve(settings, modelKey), PI_DEFAULT_COMPACTION_RESERVE_TOKENS);
  });

  it("reads the ordinary reserve and a model override", () => {
    const settings = decodePiCompactionSettings({
      compaction: {
        reserveTokens: 40_000,
        modelOverrides: { [modelKey]: { reserveTokens: 120_000 } },
      },
    });
    assert.equal(piCompactionReserve(settings, "other/model"), 40_000);
    assert.equal(piCompactionReserve(settings, modelKey), 120_000);
  });

  it("ignores malformed values rather than failing the file", () => {
    const settings = decodePiCompactionSettings({
      compaction: { reserveTokens: -1, modelOverrides: { [modelKey]: { reserveTokens: "x" } } },
    });
    assert.equal(settings.reserveTokens, PI_DEFAULT_COMPACTION_RESERVE_TOKENS);
    assert.deepEqual(settings.modelReserves, {});
    assert.equal(
      parsePiCompactionSettings("not json").reserveTokens,
      PI_DEFAULT_COMPACTION_RESERVE_TOKENS,
    );
  });

  it("reports the point more free context starts compaction", () => {
    assert.equal(piCompactionThreshold(200_000, 16_384), 183_616);
    assert.equal(piCompactionThreshold(null, 16_384), null);
    assert.equal(piCompactionThreshold(10_000, 16_384), null);
  });

  it("reports no point while Pi's automatic compaction is switched off", () => {
    assert.equal(piCompactionThreshold(200_000, 16_384, false), null);
  });

  it("never reserves less than Pi's own 16k", () => {
    assert.equal(piCompactionReserveForPoint(1_000_000, 300_000), 700_000);
    assert.equal(
      piCompactionReserveForPoint(200_000, 300_000),
      PI_DEFAULT_COMPACTION_RESERVE_TOKENS,
    );
    assert.equal(piCompactionReserveForPoint(200_000, 100_000), 100_000);
  });

  it("uses PI_CODING_AGENT_DIR, expanding a home-relative path", () => {
    assert.equal(
      piAgentDirectory({ PI_CODING_AGENT_DIR: "~/pi-agent", HOME: "/home/test" }),
      NodePath.join("/home/test", "pi-agent"),
    );
    assert.equal(
      piAgentDirectory({ HOME: "/home/test" }),
      NodePath.join("/home/test", ".pi", "agent"),
    );
    assert.equal(piAgentDirectory({ PI_CODING_AGENT_DIR: "/opt/pi-agent" }), "/opt/pi-agent");
  });

  it("has no agent directory without a home or configured directory", () => {
    assert.equal(piAgentDirectory({}), null);
    assert.equal(piAgentDirectory({ PI_CODING_AGENT_DIR: "~/pi-agent" }), null);
  });
});

describe("syncPiCompactionPoint", () => {
  const withAgentDir = <A, E>(
    use: (agentDir: string) => Effect.Effect<A, E, FileSystem.FileSystem>,
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const agentDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pi-compaction-" });
      return yield* use(agentDir);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.orDie);

  it.effect("writes the model reserve and leaves the rest of the settings alone", () =>
    withAgentDir((agentDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const settingsPath = NodePath.join(agentDir, "settings.json");
        yield* fileSystem.writeFileString(
          settingsPath,
          JSON.stringify({ defaultModel: "x", compaction: { enabled: true } }),
        );
        const result = yield* syncPiCompactionPoint({
          agentDir,
          modelKey,
          contextWindow: 1_000_000,
          compactAt: 300_000,
        });
        assert.equal(result.wrote, true);
        assert.equal(result.settings.modelReserves[modelKey], 700_000);
        assert.equal(result.settings.enabled, true);
        const written = JSON.parse(yield* fileSystem.readFileString(settingsPath));
        assert.equal(written.defaultModel, "x");
        assert.equal(written.compaction.enabled, true);
        assert.equal(written.compaction.modelOverrides[modelKey].reserveTokens, 700_000);
        const ownership = JSON.parse(
          yield* fileSystem.readFileString(
            NodePath.join(agentDir, PI_COMPACTION_OWNERSHIP_FILENAME),
          ),
        );
        assert.deepEqual(ownership.models, { [modelKey]: null });
      }),
    ),
  );

  it.effect("reports the written point on the next start and writes nothing twice", () =>
    withAgentDir((agentDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* syncPiCompactionPoint({
          agentDir,
          modelKey,
          contextWindow: 1_000_000,
          compactAt: 300_000,
        });
        const settingsPath = NodePath.join(agentDir, "settings.json");
        const once = yield* fileSystem.readFileString(settingsPath);
        const result = yield* syncPiCompactionPoint({
          agentDir,
          modelKey,
          contextWindow: 1_000_000,
          compactAt: 300_000,
        });
        assert.equal(result.wrote, false);
        assert.equal(result.settings.modelReserves[modelKey], 700_000);
        assert.equal(yield* fileSystem.readFileString(settingsPath), once);
      }),
    ),
  );

  it.effect("puts a replaced native reserve back when the point is cleared", () =>
    withAgentDir((agentDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const settingsPath = NodePath.join(agentDir, "settings.json");
        yield* fileSystem.writeFileString(
          settingsPath,
          JSON.stringify({
            compaction: {
              modelOverrides: { [modelKey]: { reserveTokens: 40_000, keepRecentTokens: 30_000 } },
            },
          }),
        );
        const applied = yield* syncPiCompactionPoint({
          agentDir,
          modelKey,
          contextWindow: 1_000_000,
          compactAt: 300_000,
        });
        assert.equal(applied.settings.modelReserves[modelKey], 700_000);
        yield* syncPiCompactionPoint({
          agentDir,
          modelKey,
          contextWindow: 1_000_000,
          compactAt: null,
        });
        const written = JSON.parse(yield* fileSystem.readFileString(settingsPath));
        assert.deepEqual(written.compaction.modelOverrides[modelKey], {
          reserveTokens: 40_000,
          keepRecentTokens: 30_000,
        });
      }),
    ),
  );

  it.effect("turns automatic compaction on when it sets a point", () =>
    withAgentDir((agentDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const settingsPath = NodePath.join(agentDir, "settings.json");
        yield* fileSystem.writeFileString(
          settingsPath,
          JSON.stringify({ compaction: { enabled: false } }),
        );
        const result = yield* syncPiCompactionPoint({
          agentDir,
          modelKey,
          contextWindow: 1_000_000,
          compactAt: 300_000,
        });
        assert.equal(result.settings.enabled, true);
        const written = JSON.parse(yield* fileSystem.readFileString(settingsPath));
        assert.equal(written.compaction.enabled, true);
      }),
    ),
  );

  it.effect("keeps two models' overrides when sessions write one after the other", () =>
    withAgentDir((agentDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const other = "opencode-go/other-model";
        yield* syncPiCompactionPoint({
          agentDir,
          modelKey,
          contextWindow: 1_000_000,
          compactAt: 300_000,
        });
        yield* syncPiCompactionPoint({
          agentDir,
          modelKey: other,
          contextWindow: 500_000,
          compactAt: 200_000,
        });
        const written = JSON.parse(
          yield* fileSystem.readFileString(NodePath.join(agentDir, "settings.json")),
        );
        assert.equal(written.compaction.modelOverrides[modelKey].reserveTokens, 700_000);
        assert.equal(written.compaction.modelOverrides[other].reserveTokens, 300_000);
      }),
    ),
  );
});
