// @effect-diagnostics nodeBuiltinImport:off — a child that has exited gives a certainly-dead pid.
import * as NodeChildProcess from "node:child_process";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "./config.ts";
import { isProcessAlive } from "./processLiveness.ts";

it.effect("sweeps a dead server's sandbox temp roots and keeps a live one's", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-config-sandbox-tmp-" });
    const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    const deadPid = NodeChildProcess.spawnSync(process.execPath, ["-e", ""]).pid ?? 0;
    assert.isFalse(isProcessAlive(deadPid));
    const dead = `${paths.sandboxTempDir}/${deadPid}-0123456789abcdef`;
    const live = `${paths.sandboxTempDir}/${process.pid}-fedcba9876543210`;
    yield* fs.makeDirectory(`${dead}/run-abc`, { recursive: true });
    yield* fs.makeDirectory(`${live}/run-def`, { recursive: true });

    yield* ServerConfig.ensureServerDirectories(paths);

    assert.isFalse(yield* fs.exists(dead));
    assert.isTrue(yield* fs.exists(live));
  }).pipe(Effect.provide(NodeServices.layer)),
);
