// @effect-diagnostics nodeBuiltinImport:off - Checks tracked source files with Git grep in Git and JJ workspaces.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const root = NodePath.resolve(import.meta.dirname, "..");
const allowlist = JSON.parse(
  NodeFS.readFileSync(new URL("../fork/legacy-name-allowlist.json", import.meta.url), "utf8"),
) as Array<{ path: string; category: string; reason: string }>;

const allowed = (path: string) => allowlist.some((entry) => NodePath.matchesGlob(path, entry.path));

// Case-sensitive so `GraphQL` stays out; covers the bare word and identifiers built on it
// (`hqRepositoryKey`, `HqForgeRecords`, `hq_origin`, `other_hq`, `HQ_TIMEOUT`, `yardsmith-hq`,
// `getHqOrigin`, `currentHq`, `getHQOrigin`).
const LEGACY_NAME = String.raw`(^|[^A-Za-z0-9])(hq|Hq|HQ)([^A-Za-z0-9]|$|[A-Z_])|[a-z](Hq|HQ)([^a-z0-9]|$)|_(hq|HQ)([^a-z]|$)`;

it.each([
  "hq",
  "HQ",
  "hqRepositoryKey",
  "HqForgeRecords",
  "hq_origin",
  "other_hq",
  "HQ_TIMEOUT",
  "yardsmith-hq",
  "getHqOrigin",
  "currentHq",
  "getHQOrigin",
])("the guard finds %s", (name) => {
  expect(new RegExp(LEGACY_NAME).test(`const ${name} = 1`)).toBe(true);
});

it.each(["GraphQL", "graphql", "GRAPHQL", "searchQuery", "weaveOrigin"])(
  "the guard leaves %s alone",
  (name) => {
    expect(new RegExp(LEGACY_NAME).test(`const ${name} = 1`)).toBe(false);
  },
);

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
        "-E",
        "-l",
        "-z",
        LEGACY_NAME,
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
  // An entry the name has left must go, or the list stops saying what is still retained.
  expect(
    allowlist
      .map((entry) => entry.path)
      .filter((pattern) => !matches.some((path) => NodePath.matchesGlob(path, pattern))),
  ).toEqual([]);
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
  expect(allowed("apps/server/src/weave/NewFeature.ts")).toBe(false);
});
