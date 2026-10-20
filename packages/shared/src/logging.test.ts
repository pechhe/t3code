// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "./HostProcess.ts";

import {
  RotatingFileSink,
  RotatingFileSinkConfigurationError,
  RotatingFileSinkError,
  makeAsyncRotatingFileSink,
} from "./logging.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const tempDirectories: string[] = [];

const makeTempDirectory = (): string => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-logging-"));
  tempDirectories.push(directory);
  return directory;
};

const captureError = (run: () => unknown): unknown => {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected operation to throw");
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

effectIt.layer(NodeServices.layer)("asynchronous rotating file sink", (it) => {
  it.effect("serializes concurrent appends across rotation and resumes an existing file", () =>
    Effect.gen(function* () {
      const directory = makeTempDirectory();
      const filePath = NodePath.join(directory, "async.log");
      NodeFS.writeFileSync(`${filePath}.50`, "obsolete");
      const lines = Array.from(
        { length: 100 },
        (_, index) => `${index.toString().padStart(3, "0")}\n`,
      );
      const sink = yield* makeAsyncRotatingFileSink({ filePath, maxBytes: 32, maxFiles: 20 });
      yield* Effect.forEach(lines, (line) => sink.write(line), {
        concurrency: "unbounded",
        discard: true,
      });
      const resumed = yield* makeAsyncRotatingFileSink({ filePath, maxBytes: 32, maxFiles: 20 });
      yield* resumed.write("100\n");
      expect(NodeFS.existsSync(`${filePath}.50`)).toBe(false);
      const backups = NodeFS.readdirSync(directory)
        .filter((name) => name.startsWith("async.log."))
        .sort((a, b) => Number(b.slice(10)) - Number(a.slice(10)));
      const contents = [...backups, "async.log"].map((name) =>
        NodeFS.readFileSync(NodePath.join(directory, name), "utf8"),
      );
      expect(contents.every((chunk) => Buffer.byteLength(chunk) <= 32)).toBe(true);
      expect(contents.join("")).toBe(lines.join("") + "100\n");
    }),
  );

  it.effect("gzips rotated files and ages out plain backups left from before", () =>
    Effect.gen(function* () {
      const directory = makeTempDirectory();
      const filePath = NodePath.join(directory, "trace.ndjson");
      NodeFS.writeFileSync(`${filePath}.2`, "older\n");
      NodeFS.writeFileSync(`${filePath}.1`, "old\n");
      const readBackups = () =>
        NodeFS.readdirSync(directory)
          .filter((name) => name !== "trace.ndjson")
          .sort((a, b) => Number(b.split(".")[2]) - Number(a.split(".")[2]))
          .map((name) => {
            const bytes = NodeFS.readFileSync(NodePath.join(directory, name));
            return name.endsWith(".gz") ? NodeZlib.gunzipSync(bytes).toString() : bytes.toString();
          });
      const sink = yield* makeAsyncRotatingFileSink({
        filePath,
        maxBytes: 16,
        maxFiles: 50,
        compressRotated: true,
      });
      const lines = Array.from({ length: 40 }, (_, index) => `${index}\n`);
      yield* Effect.forEach(lines, (line) => sink.write(line), { discard: true });

      expect([...readBackups(), NodeFS.readFileSync(filePath, "utf8")].join("")).toBe(
        ["older\n", "old\n", ...lines].join(""),
      );

      const small = yield* makeAsyncRotatingFileSink({
        filePath,
        maxBytes: 16,
        maxFiles: 3,
        compressRotated: true,
      });
      yield* Effect.forEach(lines, (line) => small.write(line), { discard: true });
      expect(
        NodeFS.readdirSync(directory)
          .filter((name) => name !== "trace.ndjson")
          .sort(),
      ).toEqual(["trace.ndjson.1.gz", "trace.ndjson.2.gz", "trace.ndjson.3.gz"]);
    }),
  );

  it.effect("touches only the backups that exist when rotating with many slots", () =>
    Effect.gen(function* () {
      const directory = makeTempDirectory();
      const filePath = NodePath.join(directory, "trace.ndjson");
      const fs = yield* FileSystem.FileSystem;
      let fileOperations = 0;
      const counted =
        <A extends ReadonlyArray<unknown>, R>(operation: (...args: A) => R) =>
        (...args: A) => {
          fileOperations++;
          return operation(...args);
        };
      const sink = yield* makeAsyncRotatingFileSink({
        filePath,
        maxBytes: 4,
        maxFiles: 360,
        compressRotated: true,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: counted(fs.exists),
          rename: counted(fs.rename),
          remove: counted(fs.remove),
        }),
      );
      const lines = ["aaa\n", "bbb\n", "ccc\n", "ddd\n"];
      yield* Effect.forEach(lines, (line) => sink.write(line), { discard: true });

      expect(NodeFS.readdirSync(directory).sort()).toEqual([
        "trace.ndjson",
        "trace.ndjson.1.gz",
        "trace.ndjson.2.gz",
        "trace.ndjson.3.gz",
      ]);
      // Three rotations shift 0, 1 and 2 backups; probing every slot would take hundreds.
      expect(fileOperations).toBeLessThan(20);
    }),
  );

  it.effect("reports a failed append and recovers its size before the next rotation", () =>
    Effect.gen(function* () {
      const directory = makeTempDirectory();
      const filePath = NodePath.join(directory, "recovery.log");
      NodeFS.writeFileSync(filePath, "old\n");
      const fs = yield* FileSystem.FileSystem;
      let attempts = 0;
      const sink = yield* makeAsyncRotatingFileSink({ filePath, maxBytes: 8, maxFiles: 2 }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFile: (path, bytes, options) =>
            ++attempts === 1
              ? fs.writeFile(directory, bytes, options)
              : fs.writeFile(path, bytes, options),
        }),
      );
      const failed = yield* sink.write("new\n").pipe(Effect.result);
      expect(failed._tag).toBe("Failure");
      if (failed._tag === "Failure") expect(failed.failure.operation).toBe("write");
      yield* sink.write("new\n");
      yield* sink.write("end\n");
      expect(NodeFS.readFileSync(`${filePath}.1`, "utf8")).toBe("old\nnew\n");
      expect(NodeFS.readFileSync(filePath, "utf8")).toBe("end\n");
    }),
  );
});

describe("RotatingFileSink", () => {
  it.each([
    { option: "maxBytes" as const, maxBytes: 0, maxFiles: 1 },
    { option: "maxFiles" as const, maxBytes: 1, maxFiles: 0 },
  ])("reports invalid $option configuration structurally", (input) => {
    const thrown = captureError(
      () =>
        new RotatingFileSink({
          filePath: "/unused/log.ndjson",
          maxBytes: input.maxBytes,
          maxFiles: input.maxFiles,
        }),
    );

    expect(thrown).toBeInstanceOf(RotatingFileSinkConfigurationError);
    expect(thrown).toMatchObject({
      option: input.option,
      received: 0,
      minimum: 1,
    });
    expect((thrown as Error).message).toBe(`${input.option} must be >= 1 (received 0)`);
  });

  it("preserves directory initialization failures", () => {
    const directory = makeTempDirectory();
    const parentFile = NodePath.join(directory, "not-a-directory");
    const filePath = NodePath.join(parentFile, "log.ndjson");
    NodeFS.writeFileSync(parentFile, "occupied");

    const thrown = captureError(() => new RotatingFileSink({ filePath, maxBytes: 1, maxFiles: 1 }));

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "initialize", filePath });
    expect((thrown as RotatingFileSinkError).cause).toBeInstanceOf(Error);
  });

  // An over-long name is the one stat failure that is neither ENOENT nor a
  // permission problem on posix. Windows reports it as ENOENT, so the sink
  // correctly treats it as an absent file and there is nothing to assert.
  it.skipIf(windowsHost)("only treats a missing log file as an empty current size", () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "a".repeat(300));

    const thrown = captureError(() => new RotatingFileSink({ filePath, maxBytes: 1, maxFiles: 1 }));

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "read", filePath });
    expect((thrown as RotatingFileSinkError).cause).toMatchObject({ code: "ENAMETOOLONG" });
  });

  it("starts an absent log file at zero bytes", () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    const sink = new RotatingFileSink({ filePath, maxBytes: 100, maxFiles: 1 });

    sink.write("entry");

    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("entry");
  });

  it("preserves write failures", () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    NodeFS.mkdirSync(filePath);
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxFiles: 1,
      throwOnError: true,
    });

    const thrown = captureError(() => sink.write("entry"));

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "write", filePath });
    expect((thrown as RotatingFileSinkError).cause).toMatchObject({ code: "EISDIR" });
  });

  it("preserves rotation failures without an artificial write wrapper", () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    NodeFS.writeFileSync(filePath, "a");
    NodeFS.mkdirSync(`${filePath}.1`);
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 1,
      maxFiles: 1,
      throwOnError: true,
    });

    const thrown = captureError(() => sink.write("b"));

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "rotate", filePath });
    expect((thrown as RotatingFileSinkError).cause).toBeInstanceOf(Error);
  });

  it("never reports a rotation failure after successfully appending a chunk", () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    NodeFS.mkdirSync(`${filePath}.1`);
    const sink = new RotatingFileSink({
      filePath,
      maxBytes: 1,
      maxFiles: 1,
      throwOnError: true,
    });

    sink.write("oversized");

    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("oversized");
    const thrown = captureError(() => sink.write("next"));
    expect(thrown).toMatchObject({ operation: "rotate", filePath });
    expect(NodeFS.readFileSync(filePath, "utf8")).toBe("oversized");
  });

  it("preserves backup pruning failures", () => {
    const directory = makeTempDirectory();
    const filePath = NodePath.join(directory, "log.ndjson");
    const overflowBackup = `${filePath}.2`;
    NodeFS.mkdirSync(overflowBackup);
    NodeFS.writeFileSync(NodePath.join(overflowBackup, "entry"), "occupied");

    const thrown = captureError(
      () =>
        new RotatingFileSink({
          filePath,
          maxBytes: 1,
          maxFiles: 1,
          throwOnError: true,
        }),
    );

    expect(thrown).toBeInstanceOf(RotatingFileSinkError);
    expect(thrown).toMatchObject({ operation: "prune", filePath });
    expect((thrown as RotatingFileSinkError).cause).toBeInstanceOf(Error);
  });
});
