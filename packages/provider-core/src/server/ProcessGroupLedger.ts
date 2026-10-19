import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { signalProcessGroup } from "./processGroup.ts";

const ProcessIdentity = Schema.Struct({ pid: Schema.Int, startTime: Schema.String });
type ProcessIdentity = typeof ProcessIdentity.Type;

const ProcessGroupEntry = Schema.Struct({
  version: Schema.Literal(1),
  pgid: Schema.Int,
  pid: Schema.Int,
  startTime: Schema.String,
  command: Schema.String,
  stateDir: Schema.String,
  owner: ProcessIdentity,
});
type ProcessGroupEntry = typeof ProcessGroupEntry.Type;
const ProcessGroupEntryJson = Schema.fromJsonString(ProcessGroupEntry);
const decodeEntry = Schema.decodeUnknownOption(ProcessGroupEntryJson);
const encodeEntry = Schema.encodeEffect(ProcessGroupEntryJson);

/**
 * Records each provider process group this server starts, under the state directory, so the
 * groups a crashed or force-killed server left running are stopped by the next server, or by
 * the desktop app once its servers have exited. A provider such as Claude Code stops the
 * commands it started when it gets SIGTERM, but leaves them running when it is killed outright.
 */
export interface ProcessGroupLedgerShape {
  /** Returns the effect that forgets the group once it has stopped. */
  readonly track: (group: {
    readonly pid: number;
    readonly args: ReadonlyArray<string>;
  }) => Effect.Effect<Effect.Effect<void>>;
}

/** Records nothing unless the server provides `layer`, so tests need no state directory. */
export const ProcessGroupLedger = Context.Reference<ProcessGroupLedgerShape>(
  "@t3tools/provider-core/server/ProcessGroupLedger",
  { defaultValue: () => ({ track: () => Effect.succeed(Effect.void) }) },
);

const PROCESS_GROUP_DIRECTORY = "provider-processes";
const ENTRY_FILE = /^\d+\.json$/;
const STOP_POLL_INTERVAL = "50 millis";
const STOP_POLL_ATTEMPTS = 40;

interface ObservedProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly startTime: string;
  readonly command: string;
  readonly zombie: boolean;
}

// `ps -o lstart` prints e.g. `Sat Sep  6 20:51:57 2026`; C locale and UTC keep it stable.
const DARWIN_PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

const parseDarwinPs = (output: string): ReadonlyArray<ObservedProcess> =>
  output.split("\n").flatMap((line) => {
    const match = DARWIN_PS_LINE.exec(line);
    if (match === null) return [];
    return [
      {
        pid: Number(match[1]),
        pgid: Number(match[2]),
        zombie: match[3]!.startsWith("Z"),
        startTime: match[4]!,
        command: match[5]!.trimEnd(),
      },
    ];
  });

const signalGroup = (pgid: number, signal: NodeJS.Signals) => {
  try {
    signalProcessGroup(pgid, signal);
  } catch {}
};

const pidExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
};

const groupExists = (pgid: number) => {
  try {
    signalProcessGroup(pgid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
};

export const make = Effect.fn("ProcessGroupLedger.make")(function* (input: {
  readonly stateDir: string;
  readonly ownerPid?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const directory = path.join(input.stateDir, PROCESS_GROUP_DIRECTORY);
  const recordable = platform === "linux" || platform === "darwin";

  const observeLinux = (pid: number, group?: number) =>
    Effect.gen(function* () {
      const stat = yield* fs.readFileString(`/proc/${pid}/stat`);
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const pgid = Number(fields[2]);
      const startTime = fields[19];
      if (!Number.isSafeInteger(pgid) || startTime === undefined) return undefined;
      if (group !== undefined && pgid !== group) return undefined;
      const cmdline = yield* fs.readFileString(`/proc/${pid}/cmdline`);
      return {
        pid,
        pgid,
        startTime,
        command: cmdline.replace(/\0$/, "").replaceAll("\0", " "),
        zombie: fields[0] === "Z",
      } satisfies ObservedProcess;
    });

  const psDarwin = (selection: ReadonlyArray<string>) =>
    spawner
      .string(
        ChildProcess.make(
          "/bin/ps",
          ["-ww", "-o", "pid=,pgid=,stat=,lstart=,args=", ...selection],
          {
            env: { LC_ALL: "C", TZ: "UTC" },
            extendEnv: true,
            stdin: "ignore",
            stderr: "ignore",
          },
        ),
      )
      .pipe(Effect.timeout("5 seconds"), Effect.map(parseDarwinPs));

  const observe = (pid: number): Effect.Effect<ObservedProcess | undefined> => {
    if (platform === "linux") return observeLinux(pid).pipe(Effect.orElseSucceed(() => undefined));
    if (platform === "darwin") {
      return psDarwin(["-p", String(pid)]).pipe(
        Effect.map((found) => found.find((candidate) => candidate.pid === pid)),
        Effect.orElseSucceed(() => undefined),
      );
    }
    return Effect.succeed(undefined);
  };

  const observeGroup = (pgid: number): Effect.Effect<ReadonlyArray<ObservedProcess>> => {
    if (platform === "linux") {
      return fs.readDirectory("/proc").pipe(
        Effect.flatMap((names) =>
          Effect.forEach(
            names.filter((name) => /^\d+$/.test(name)),
            (name) => observeLinux(Number(name), pgid).pipe(Effect.orElseSucceed(() => undefined)),
            { concurrency: 16 },
          ),
        ),
        Effect.map((found) => found.filter((candidate) => candidate !== undefined)),
        Effect.orElseSucceed(() => []),
      );
    }
    if (platform === "darwin") {
      return psDarwin(["-A"]).pipe(
        Effect.map((found) => found.filter((candidate) => candidate.pgid === pgid)),
        Effect.orElseSucceed(() => []),
      );
    }
    return Effect.succeed([]);
  };

  const isRunning = (identity: ProcessIdentity) =>
    observe(identity.pid).pipe(
      Effect.map(
        (observed) =>
          observed !== undefined && !observed.zombie && observed.startTime === identity.startTime,
      ),
    );

  const ownerPid = input.ownerPid ?? process.pid;
  const ownerProcess = yield* observe(ownerPid);
  const owner =
    ownerProcess === undefined ? undefined : { pid: ownerPid, startTime: ownerProcess.startTime };

  const track: ProcessGroupLedgerShape["track"] = (group) =>
    Effect.gen(function* () {
      if (!recordable) return Effect.void;
      const pgid = group.pid;
      // The spawned process leads the group. If it already exited (a wrapper
      // that left the server running), any live member identifies the group:
      // a group id is not reused while the group has members.
      const leader = yield* observe(pgid);
      const members =
        leader !== undefined && !leader.zombie && leader.pgid === pgid
          ? [leader]
          : (yield* observeGroup(pgid)).filter((candidate) => !candidate.zombie);
      const member =
        members.find((candidate) => candidate.command.endsWith(` ${group.args.join(" ")}`)) ??
        members[0];
      if (owner === undefined || member === undefined) {
        if (groupExists(pgid)) {
          yield* Effect.logWarning(
            "Could not record a provider process; it will keep running if this server crashes",
            { pid: pgid },
          );
        }
        return Effect.void;
      }
      const entryPath = path.join(directory, `${pgid}.json`);
      const entry: ProcessGroupEntry = {
        version: 1,
        pgid,
        pid: member.pid,
        startTime: member.startTime,
        command: member.command,
        stateDir: input.stateDir,
        owner,
      };
      yield* writeFileStringAtomically({
        filePath: entryPath,
        contents: yield* encodeEntry(entry),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      return fs
        .remove(entryPath, { force: true })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not forget a stopped provider process", { cause }),
          ),
        );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not record a provider process", { cause }).pipe(
          Effect.as(Effect.void),
        ),
      ),
    );

  // Signals only a group whose recorded member still has the same pid, start
  // time, group, and full command line, so a recycled pid is never touched.
  const stopOrphan = (entry: ProcessGroupEntry) =>
    Effect.gen(function* () {
      const observed = yield* observe(entry.pid);
      if (
        observed === undefined ||
        observed.zombie ||
        observed.startTime !== entry.startTime ||
        observed.pgid !== entry.pgid ||
        observed.command !== entry.command
      ) {
        return;
      }
      yield* Effect.logInfo("Stopping a provider process left by a previous T3 Code server", {
        pid: entry.pgid,
      });
      signalGroup(entry.pgid, "SIGTERM");
      for (let attempt = 0; attempt < STOP_POLL_ATTEMPTS && groupExists(entry.pgid); attempt++) {
        yield* Effect.sleep(STOP_POLL_INTERVAL);
      }
      // The group never emptied, so its pgid cannot have been reused.
      if (groupExists(entry.pgid)) signalGroup(entry.pgid, "SIGKILL");
    });

  const outlives = (owner: ProcessIdentity, grace: Duration.Duration) =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(grace);
      while ((yield* Clock.currentTimeMillis) < deadline && pidExists(owner.pid)) {
        yield* Effect.sleep(STOP_POLL_INTERVAL);
      }
      return yield* isRunning(owner);
    });

  const reapEntry = (entryPath: string, ownerExitGrace: Duration.Duration) =>
    Effect.gen(function* () {
      const entry = decodeEntry(yield* fs.readFileString(entryPath));
      if (Option.isSome(entry) && entry.value.stateDir === input.stateDir) {
        if (yield* outlives(entry.value.owner, ownerExitGrace)) return;
        yield* stopOrphan(entry.value);
      }
      yield* fs.remove(entryPath, { force: true });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not clean up a recorded provider process", { entryPath, cause }),
      ),
    );

  /**
   * `ownerExitGrace` waits that long for an owning server that is still running to exit, for a
   * caller that has just asked it to stop.
   */
  const reapOrphans = (ownerExitGrace: Duration.Duration = Duration.zero) =>
    Effect.gen(function* () {
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      names.filter((name) => ENTRY_FILE.test(name)),
      (name) => reapEntry(path.join(directory, name), ownerExitGrace),
      { concurrency: "unbounded", discard: true },
    );
  });

  return { track, reapOrphans };
});

/** Stops the recorded groups whose owning server is no longer running. */
export const reapOrphans = (input: {
  readonly stateDir: string;
  readonly ownerExitGrace?: Duration.Duration;
}) => make(input).pipe(Effect.flatMap((ledger) => ledger.reapOrphans(input.ownerExitGrace)));

export const layer = (input: { readonly stateDir: string }) =>
  Layer.effect(
    ProcessGroupLedger,
    Effect.gen(function* () {
      const ledger = yield* make(input);
      yield* ledger.reapOrphans().pipe(Effect.forkScoped);
      return { track: ledger.track };
    }),
  );
