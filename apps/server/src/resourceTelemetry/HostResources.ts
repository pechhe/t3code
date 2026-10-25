import * as NodeOS from "node:os";
import type { HostResourcesSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class HostResources extends Context.Service<
  HostResources,
  { readonly read: Effect.Effect<HostResourcesSnapshot> }
>()("t3/resourceTelemetry/HostResources") {}

function readCpu() {
  const cpus = NodeOS.cpus();
  const cpu = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
  return { ...cpu, count: cpus.length };
}

function darwinAvailableMemory(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1];
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1];
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1];
  if (!pageSize || !free || !inactive || !speculative) return null;
  // vm_stat excludes speculative from free; add it once, without overlapping purgeable pages.
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize);
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null;
}

export interface HostMemory {
  readonly totalBytes: number;
  readonly availableBytes: number;
  /** Null where the platform reports no swap (Windows) or the read failed. */
  readonly swapUsedBytes: number | null;
  readonly swapTotalBytes: number | null;
}

const UNITS: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** Parses `sysctl -n vm.swapusage`: `total = 10240.00M  used = 9876.12M  free = 363.88M  (encrypted)`. */
export function darwinSwap(output: string) {
  const match = /total = ([\d.]+)([KMGT])\s+used = ([\d.]+)([KMGT])/.exec(output);
  if (match === null) return null;
  const total = Number(match[1]) * UNITS[match[2]!]!;
  const used = Number(match[3]) * UNITS[match[4]!]!;
  return Number.isFinite(total) && Number.isFinite(used)
    ? { totalBytes: Math.round(total), usedBytes: Math.round(used) }
    : null;
}

/**
 * Available memory is what the OS can hand out without paging; swap shows whether it already
 * is. Needs a subprocess on macOS, so it is for samples taken for a reason, not for a timer.
 */
export const readHostMemory = Effect.fn("HostResources.readMemory")(function* (options?: {
  /** Skip the macOS swap subprocess for callers that only need available memory. */
  readonly swap?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const totalBytes = NodeOS.totalmem();
  // On Windows libuv returns GlobalMemoryStatusEx.ullAvailPhys, including standby memory.
  let availableBytes = NodeOS.freemem();
  let swap: { readonly usedBytes: number; readonly totalBytes: number } | null = null;
  if (platform === "linux") {
    const meminfo = yield* fs.readFileString("/proc/meminfo").pipe(Effect.orElseSucceed(() => ""));
    const field = (name: string) => {
      const value = new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, "m").exec(meminfo)?.[1];
      return value === undefined ? null : Number(value) * 1024;
    };
    availableBytes = field("MemAvailable") ?? availableBytes;
    const swapTotal = field("SwapTotal");
    const swapFree = field("SwapFree");
    if (swapTotal !== null && swapFree !== null) {
      swap = { totalBytes: swapTotal, usedBytes: swapTotal - swapFree };
    }
  } else if (platform === "darwin") {
    const run = (executable: string, args: ReadonlyArray<string>) =>
      spawner
        .string(ChildProcess.make(executable, args, { stdin: "ignore", stderr: "ignore" }))
        .pipe(
          Effect.timeout("1 second"),
          Effect.orElseSucceed(() => ""),
        );
    const [vmStat, swapUsage] = yield* Effect.all(
      [
        run("/usr/bin/vm_stat", []),
        options?.swap === false
          ? Effect.succeed("")
          : run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
      ],
      { concurrency: "unbounded" },
    );
    availableBytes = darwinAvailableMemory(vmStat) ?? availableBytes;
    swap = darwinSwap(swapUsage);
  }
  return {
    totalBytes,
    availableBytes: Math.min(totalBytes, Math.max(0, availableBytes)),
    swapUsedBytes: swap?.usedBytes ?? null,
    swapTotalBytes: swap?.totalBytes ?? null,
  } satisfies HostMemory;
});

export type HostMemoryServices = Effect.Services<ReturnType<typeof readHostMemory>>;

const make = Effect.fn("makeHostResources")(function* () {
  const context = yield* Effect.context<HostMemoryServices>();

  const sample = Effect.fn("HostResources.sample")(function* () {
    const previousCpu = readCpu();
    yield* Effect.sleep("200 millis");
    const cpu = readCpu();
    const totalDelta = cpu.total - previousCpu.total;
    const idleDelta = cpu.idle - previousCpu.idle;
    const cpuUtilization =
      previousCpu.count === cpu.count && totalDelta > 0 && idleDelta >= 0
        ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
        : null;
    const memory = yield* readHostMemory({ swap: false }).pipe(Effect.provideContext(context));
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount: cpu.count,
      availableMemoryBytes: memory.availableBytes,
      totalMemoryBytes: memory.totalBytes,
    };
  });

  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });
  return HostResources.of({ read: Cache.get(cache, "host") });
});

export const layer = Layer.effect(HostResources, make());
