// @effect-diagnostics nodeBuiltinImport:off - Checks tracked source files with Git grep in Git and JJ workspaces.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const root = NodePath.resolve(import.meta.dirname, "..");
const allowlist = JSON.parse(
  NodeFS.readFileSync(new URL("../fork/hq-allowlist.json", import.meta.url), "utf8"),
) as Array<{ path: string; category: string; reason: string }>;

const allowed = (path: string) => allowlist.some((entry) => NodePath.matchesGlob(path, entry.path));

it("keeps every legacy product-name grep match inside the reviewed allowlist", () => {
  const gitFiles = NodeChildProcess.spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  // SlipJay's JJ workspaces have no .git; enumerate their tracked tree without snapshotting.
  const tracked =
    gitFiles.status === 0
      ? gitFiles
      : NodeChildProcess.spawnSync(
          "jj",
          ["--ignore-working-copy", "file", "list", "-T", String.raw`path ++ "\0"`],
          {
            cwd: root,
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
          },
        );
  expect(tracked.error).toBeUndefined();
  expect(tracked.status, tracked.stderr).toBe(0);
  const files = tracked.stdout.split("\0").filter(Boolean);
  expect(files.length).toBeGreaterThan(0);
  const matches: Array<string> = [];
  for (let offset = 0; offset < files.length; offset += 500) {
    const result = NodeChildProcess.spawnSync(
      "git",
      [
        "grep",
        "--no-index",
        "-I",
        "-i",
        "-l",
        "-z",
        String.raw`\bhq\b`,
        "--",
        ...files.slice(offset, offset + 500),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect([0, 1], result.stderr).toContain(result.status);
    matches.push(...result.stdout.split("\0").filter(Boolean));
  }
  expect(matches.filter((path) => !allowed(path))).toEqual([]);
});

it("requires a category and reason for every retained path and rejects unrelated new source", () => {
  expect(new Set(allowlist.map((entry) => entry.path)).size).toBe(allowlist.length);
  for (const entry of allowlist) {
    expect([
      "append-only-history",
      "captured-fixtures",
      "compatibility-aliases",
      "stored-storage-wire",
    ]).toContain(entry.category);
    expect(entry.reason.trim().length).toBeGreaterThan(0);
    expect(entry.path).not.toBe("**");
  }
  expect(allowed("apps/server/src/new-weave-feature.ts")).toBe(false);
  expect(allowed("apps/server/src/hq/NewFeature.ts")).toBe(false);
});
