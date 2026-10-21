import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as EventLoopMonitor from "./EventLoopMonitor.ts";

const ms = (value: number) => value * 1e6;

// Node reports a stall of S as a gap of up to S + 1 s, the histogram resolution.
const stalled: EventLoopMonitor.EventLoopReadings = {
  delayMaxNs: ms(5_950),
  activeMs: 6_200,
  utilization: 0.176,
  usage: {
    userCPUTime: 310_400,
    systemCPUTime: 95_600,
    majorPageFault: 8_412,
    minorPageFault: 20_031,
    involuntaryContextSwitches: 57,
  },
  rssBytes: 1536 * 1024 * 1024,
  heapUsedBytes: 512 * 1024 * 1024,
  elapsedMs: 30_000,
  loadAverage: 219.43,
  cpuCount: 18,
};

// Waking from sleep reads as a long gap, but the loop was idle in poll for it.
const asleep: EventLoopMonitor.EventLoopReadings = {
  ...stalled,
  delayMaxNs: ms(600_000),
  activeMs: 900,
};

describe("EventLoopMonitor", () => {
  it("tells delay the loop spent running from delay it spent idle", () => {
    assert.deepEqual(EventLoopMonitor.loopDelay(stalled), { kind: "stall", delayMs: 4_950 });
    assert.deepEqual(EventLoopMonitor.loopDelay(asleep), { kind: "freeze", delayMs: 599_000 });
    assert.deepEqual(EventLoopMonitor.loopDelay({ ...asleep, activeMs: 600_000 }), {
      kind: "stall",
      delayMs: 599_000,
    });
    assert.isUndefined(EventLoopMonitor.loopDelay({ ...stalled, delayMaxNs: ms(2_900) }));
  });

  it.effect("records a freeze apart from a stall, each with the host's load and swap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-event-loop-monitor-" });
      const filePath = path.join(directory, "event-loop-stalls.ndjson");

      const idle = { ...stalled, delayMaxNs: ms(1_000), activeMs: 10 };
      // The first sample after startup is skipped; the rest arrive one per tick.
      const upcoming = [idle, asleep];
      const sample = Effect.sync(() => upcoming.shift() ?? idle);
      const context = yield* Layer.build(
        EventLoopMonitor.layerWith(
          Effect.succeed(sample),
          { filePath, maxBytes: 1024 * 1024 },
          Effect.succeed({
            totalBytes: 32 * 1024 ** 3,
            availableBytes: 60 * 1024 ** 2,
            swapUsedBytes: 9 * 1024 ** 3,
            swapTotalBytes: 10 * 1024 ** 3,
          }),
        ),
      );
      const monitor = Context.get(context, EventLoopMonitor.EventLoopMonitor);

      yield* TestClock.adjust("30 seconds");
      yield* TestClock.adjust("30 seconds");
      // A freeze is not something a client was shown as the server stalling.
      assert.isUndefined(yield* monitor.latestNoticeableStall);
      upcoming.push({ ...stalled, delayMaxNs: ms(6_500) });
      yield* TestClock.adjust("30 seconds");

      const rows = (yield* fs.readFileString(filePath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.lengthOf(rows, 2);
      const [freeze, stall] = rows;
      assert.strictEqual(freeze!.kind, "freeze");
      assert.strictEqual(freeze!.freezeMs, 599_000);
      assert.isUndefined(freeze!.delayMaxMs);
      assert.strictEqual(stall!.kind, "stall");
      assert.strictEqual(stall!.delayMaxMs, 5_500);
      for (const row of rows) {
        assert.strictEqual(row.loadAverage, 219.4);
        assert.strictEqual(row.cpuCount, 18);
        assert.strictEqual(row.availableMemoryMb, 60);
        assert.strictEqual(row.totalMemoryMb, 32 * 1024);
        assert.strictEqual(row.swapUsedMb, 9 * 1024);
        assert.strictEqual(row.swapTotalMb, 10 * 1024);
      }
      assert.strictEqual((yield* monitor.latestNoticeableStall)?.durationMs, 5_500);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("answers a reconnecting client without waiting for the host reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-event-loop-monitor-" });
      const upcoming: Array<EventLoopMonitor.EventLoopReadings> = [];
      const idle = { ...stalled, delayMaxNs: ms(1_000), activeMs: 10 };
      const context = yield* Layer.build(
        EventLoopMonitor.layerWith(
          Effect.succeed(Effect.sync(() => upcoming.shift() ?? idle)),
          { filePath: path.join(directory, "event-loop-stalls.ndjson"), maxBytes: 1024 * 1024 },
          Effect.never,
        ),
      );
      const monitor = Context.get(context, EventLoopMonitor.EventLoopMonitor);

      yield* TestClock.adjust("30 seconds");
      upcoming.push({ ...stalled, delayMaxNs: ms(6_500) });
      assert.strictEqual((yield* monitor.latestNoticeableStall)?.durationMs, 5_500);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
