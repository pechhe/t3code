import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ProcessGroupLedger from "@t3tools/provider-core/server/ProcessGroupLedger";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makePiRpcConnection } from "./rpc.ts";

describe.skipIf(process.platform === "win32")("Pi process groups", () => {
  it.effect("records the Pi group while JSONL works and forgets it on exit", () =>
    Effect.gen(function* () {
      const forgotten = yield* Deferred.make<void>();
      const groups: number[] = [];
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const ledger = yield* ProcessGroupLedger.make({ stateDir });
      const connection = yield* makePiRpcConnection({
        command: process.execPath,
        args: ["-e", "process.stdin.once('data', () => process.exit(0))"],
        cwd: undefined,
        env: process.env,
      }).pipe(
        Effect.provideService(ProcessGroupLedger.ProcessGroupLedger, {
          track: ({ pid, args }) =>
            Effect.gen(function* () {
              groups.push(pid);
              const forget = yield* ledger.track({ pid, args });
              return forget.pipe(
                Effect.andThen(Deferred.succeed(forgotten, undefined)),
                Effect.asVoid,
              );
            }),
        }),
      );
      assert.lengthOf(groups, 1);
      assert.doesNotThrow(() => process.kill(-groups[0]!, 0));
      assert.deepEqual(yield* fs.readDirectory(path.join(stateDir, "provider-processes")), [
        `${groups[0]}.json`,
      ]);
      yield* connection.send({ type: "shutdown" });
      assert.equal(yield* connection.exited, 0);
      yield* Deferred.await(forgotten);
      assert.deepEqual(yield* fs.readDirectory(path.join(stateDir, "provider-processes")), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
