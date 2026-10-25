import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";
import * as SlipJayLandings from "../project/SlipJayLandings.ts";
import * as Inspection from "./WorkspaceInspection.ts";

const layer = Layer.effect(Inspection.WorkspaceInspection, Inspection.make).pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

const sh = (cwd: string, command: "git" | "jj", ...args: string[]) =>
  Effect.gen(function* () {
    const processes = yield* ProcessRunner.ProcessRunner;
    const out = yield* processes.run({
      command,
      args,
      cwd,
      env: {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
    assert.strictEqual(out.code, 0, out.stderr);
    return out.stdout;
  });

const write = (root: string, name: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${root}/${name}`;
    yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    yield* fs.writeFileString(path, text);
  });

const base = {
  "src/a.ts": "export const a = 1;\nexport const needle = 'findme';\n",
  "src/b.ts": "export const b = 2;\n",
  "README.md": "# hello\n",
  ".gitignore": "ignored.txt\n",
};

const gitRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-inspect-git-" }));
  yield* sh(root, "git", "init", "-q", "-b", "main");
  for (const [name, text] of Object.entries(base)) yield* write(root, name, text);
  yield* sh(root, "git", "add", "-A");
  yield* sh(root, "git", "commit", "-q", "-m", "base");
  return root;
});

const jjRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-inspect-jj-" }));
  yield* sh(root, "jj", "git", "init", ".");
  for (const [name, text] of Object.entries(base)) yield* write(root, name, text);
  yield* sh(root, "jj", "commit", "-m", "base");
  return root;
});

const refusal = <A, R>(effect: Effect.Effect<A, Inspection.WorkspaceInspectionError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

/** Every byte under the root, `.git` and `.jj` included, so a read that mutates anything shows. */
const fingerprintTree = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = (yield* fs.readDirectory(root, { recursive: true })).toSorted();
    const parts: string[] = [];
    for (const entry of entries) {
      const info = yield* fs.stat(`${root}/${entry}`);
      parts.push(
        info.type === "File"
          ? `${entry}:${(yield* fs.readFile(`${root}/${entry}`)).length}:${info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0}`
          : entry,
      );
    }
    return parts.join("\n");
  });

describe.each(["git", "jj"] as const)("WorkspaceInspection on %s", (kind) => {
  const repo = kind === "git" ? gitRepo : jjRepo;

  it.effect("reports a clean checkout and the same token until the workspace changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* repo;
        const inspection = yield* Inspection.WorkspaceInspection;
        const first = yield* inspection.observe(root);
        assert.strictEqual(first.vcs, kind);
        assert.deepStrictEqual(first.changes, []);
        assert.strictEqual((yield* inspection.observe(root)).token, first.token);
        yield* write(root, "src/b.ts", "export const b = 3;\n");
        const dirty = yield* inspection.observe(root);
        assert.notStrictEqual(dirty.token, first.token);
        assert.deepStrictEqual(
          dirty.changes.map((change) => [change.path, change.status]),
          [["src/b.ts", "M"]],
        );
        assert.strictEqual(
          yield* refusal(inspection.requireCurrent(root, first.token)),
          "stale_source",
        );
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("sees uncommitted edits, new files and deletions but not ignored files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* repo;
        const inspection = yield* Inspection.WorkspaceInspection;
        yield* write(root, "src/a.ts", "export const a = 2;\n");
        yield* write(root, "src/new.ts", "export const fresh = true;\n");
        yield* write(root, "ignored.txt", "nope\n");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(`${root}/README.md`);
        const source = yield* inspection.observe(root);
        const byPath = Object.fromEntries(source.changes.map((c) => [c.path, c.status]));
        assert.strictEqual(byPath["src/a.ts"], "M");
        assert.strictEqual(byPath["src/new.ts"], kind === "git" ? "?" : "?");
        assert.strictEqual(byPath["README.md"], "D");
        assert.isUndefined(byPath["ignored.txt"]);
        const diff = yield* inspection.diff(root, { token: source.token, scope: "working" });
        assert.include(diff.diff, "export const a = 2;");
        assert.include(diff.diff, "export const fresh = true;");
        assert.notInclude(diff.diff, "nope");
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("reads bounded ranges and refuses unsafe or sensitive paths", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* repo;
        const inspection = yield* Inspection.WorkspaceInspection;
        yield* write(root, ".env", "TOKEN=abc\n");
        yield* write(root, "ignored.txt", "nope\n");
        yield* write(root, "src/key.ts", "const k = `-----BEGIN RSA PRIVATE KEY-----`;\n");
        yield* write(root, "bin.dat", "a\u0000b");
        if (kind === "git") yield* sh(root, "git", "add", "-A");
        const token = (yield* inspection.observe(root)).token;
        const read = yield* inspection.readFile(root, {
          token,
          path: "src/a.ts",
          startLine: 2,
          lineCount: 1,
        });
        assert.strictEqual(read.content, "export const needle = 'findme';");
        assert.strictEqual(read.startLine, 2);
        for (const [path, reason] of [
          ["/etc/passwd", "invalid_path"],
          ["../outside", "invalid_path"],
          ["src/../src/a.ts", "invalid_path"],
          [".env", "denied_path"],
          [".git/config", "denied_path"],
          ["src/key.ts", "denied_path"],
          ["ignored.txt", "not_found"],
          ["missing.ts", "not_found"],
          ["bin.dat", "not_text"],
        ] as const) {
          assert.strictEqual(
            yield* refusal(inspection.readFile(root, { token, path })),
            reason,
            path,
          );
        }
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("never follows a symlink out of the workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* repo;
        const fs = yield* FileSystem.FileSystem;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-inspect-outside-" });
        yield* write(outside, "secret.txt", "outside\n");
        yield* fs.symlink(`${outside}/secret.txt`, `${root}/link.txt`);
        const inspection = yield* Inspection.WorkspaceInspection;
        const token = (yield* inspection.observe(root)).token;
        assert.strictEqual(
          yield* refusal(inspection.readFile(root, { token, path: "link.txt" })),
          "not_found",
        );
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("pages content search deterministically and excludes denied and ignored files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* repo;
        const inspection = yield* Inspection.WorkspaceInspection;
        for (let index = 0; index < 5; index += 1)
          yield* write(root, `src/n${index}.ts`, `const needle${index} = 'findme';\n`);
        yield* write(root, ".env", "findme\n");
        yield* write(root, "ignored.txt", "findme\n");
        const token = (yield* inspection.observe(root)).token;
        const paths: string[] = [];
        let cursor: string | undefined;
        do {
          const page = yield* inspection.search(root, {
            token,
            query: "findme",
            mode: "content",
            limit: 2,
            cursor,
          });
          paths.push(...page.matches.map((match) => match.path));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        assert.deepStrictEqual(paths, [
          "src/a.ts",
          "src/n0.ts",
          "src/n1.ts",
          "src/n2.ts",
          "src/n3.ts",
          "src/n4.ts",
        ]);
        const named = yield* inspection.search(root, { token, query: "b.ts", mode: "name" });
        assert.deepStrictEqual(
          named.matches.map((match) => match.path),
          ["src/b.ts"],
        );
        const first = yield* inspection.search(root, {
          token,
          query: "findme",
          mode: "content",
          limit: 1,
        });
        yield* write(root, "src/late.ts", "findme\n");
        assert.strictEqual(
          yield* refusal(
            inspection.search(root, {
              token,
              query: "findme",
              mode: "content",
              cursor: first.nextCursor ?? "",
            }),
          ),
          "stale_source",
        );
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("continues a page inside one file that holds more matches than the limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* repo;
        const inspection = yield* Inspection.WorkspaceInspection;
        yield* write(root, "src/many.ts", "markerhere\nmarkerhere\nmarkerhere\n");
        const token = (yield* inspection.observe(root)).token;
        const first = yield* inspection.search(root, {
          token,
          query: "markerhere",
          mode: "content",
          limit: 2,
        });
        assert.deepStrictEqual(
          first.matches.map((match) => [match.path, match.line]),
          [
            ["src/many.ts", 1],
            ["src/many.ts", 2],
          ],
        );
        const second = yield* inspection.search(root, {
          token,
          query: "markerhere",
          mode: "content",
          limit: 2,
          cursor: first.nextCursor ?? "",
        });
        assert.deepStrictEqual(
          second.matches.map((match) => [match.path, match.line]),
          [["src/many.ts", 3]],
        );
        assert.isNull(second.nextCursor);
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("keeps a cursor inside its bound however long the query and prefix are", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* repo;
        const inspection = yield* Inspection.WorkspaceInspection;
        const deep = Array.from({ length: 20 }, (_, index) => `level${index}`).join("/");
        const marker = "m".repeat(200);
        yield* write(root, `${deep}/f.ts`, `${marker}\n${marker}\n`);
        const token = (yield* inspection.observe(root)).token;
        const page = yield* inspection.search(root, {
          token,
          query: marker,
          mode: "content",
          pathPrefix: deep,
          limit: 1,
        });
        assert.isNotNull(page.nextCursor);
        assert.isAtMost(page.nextCursor.length, Inspection.INSPECTION_LIMITS.cursorChars);
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("drops diff blocks that touch secrets and pages the rest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* repo;
        const inspection = yield* Inspection.WorkspaceInspection;
        yield* write(root, "src/a.ts", `${"// filler line\n".repeat(3000)}export const a = 2;\n`);
        yield* write(root, "src/leak.ts", "const k = '-----BEGIN PRIVATE KEY-----';\n");
        const token = (yield* inspection.observe(root)).token;
        const first = yield* inspection.diff(root, { token, scope: "working" });
        assert.notInclude(first.diff, "BEGIN PRIVATE KEY");
        assert.isAtLeast(first.omittedPaths, 1);
        assert.isNotNull(first.nextCursor);
        assert.isAtMost(Buffer.byteLength(first.diff), Inspection.INSPECTION_LIMITS.responseBytes);
        const second = yield* inspection.diff(root, {
          token,
          scope: "working",
          cursor: first.nextCursor ?? "",
        });
        assert.notStrictEqual(second.diff, first.diff);
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("returns history and the committed diff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* repo;
        const inspection = yield* Inspection.WorkspaceInspection;
        const token = (yield* inspection.observe(root)).token;
        const log = yield* inspection.log(root, { token });
        assert.include(
          log.entries.map((entry) => entry.summary),
          "base",
        );
        const committed = yield* inspection.diff(root, { token, scope: "committed" });
        assert.isString(committed.diff);
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("changes nothing in the checkout or its VCS metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* repo;
        const inspection = yield* Inspection.WorkspaceInspection;
        yield* write(root, "src/b.ts", "export const b = 9;\n");
        yield* write(root, "src/extra.ts", "export const extra = 1;\n");
        const before = yield* fingerprintTree(root);
        const source = yield* inspection.observe(root);
        yield* inspection.readFile(root, { token: source.token, path: "src/b.ts" });
        yield* inspection.search(root, { token: source.token, query: "export", mode: "content" });
        yield* inspection.log(root, { token: source.token });
        yield* inspection.diff(root, { token: source.token, scope: "working" });
        yield* inspection.diff(root, { token: source.token, scope: "committed" });
        assert.strictEqual(yield* fingerprintTree(root), before);
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("refuses a workspace that has been removed or replaced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* repo;
        const fs = yield* FileSystem.FileSystem;
        const inspection = yield* Inspection.WorkspaceInspection;
        const token = (yield* inspection.observe(root)).token;
        yield* fs.remove(root, { recursive: true });
        yield* fs.makeDirectory(root);
        assert.strictEqual(
          yield* refusal(inspection.requireCurrent(root, token)),
          "workspace_unavailable",
        );
      }).pipe(Effect.provide(layer)),
    ),
  );
});

describe.each(["git", "jj"] as const)("WorkspaceInspection safeguards on %s", (kind) => {
  const repo = kind === "git" ? gitRepo : jjRepo;

  it.effect(
    "hides a file holding a secret from search and diff even when the match is elsewhere",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* repo;
          const inspection = yield* Inspection.WorkspaceInspection;
          const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----\n";
          yield* write(root, "config/notes.txt", `${pem}marker-visible\n`);
          yield* sh(root, kind, ...(kind === "git" ? ["add", "-A"] : ["commit", "-m", "notes"]));
          if (kind === "git") yield* sh(root, "git", "commit", "-q", "-m", "notes");
          yield* write(
            root,
            "config/notes.txt",
            `${pem.replace("MIIEvQIBADANBgkq", "ZZZZvQIBADANBgkq")}marker-visible\n`,
          );
          yield* write(root, "src/a.ts", "export const a = 5;\n");
          const token = (yield* inspection.observe(root)).token;
          const found = yield* inspection.search(root, {
            token,
            query: "marker-visible",
            mode: "content",
          });
          assert.deepStrictEqual(found.matches, []);
          const diff = yield* inspection.diff(root, { token, scope: "working" });
          assert.notInclude(diff.diff, "ZZZZvQIBADANBgkq");
          assert.notInclude(diff.diff, "marker-visible");
          assert.include(diff.diff, "export const a = 5;");
          assert.isAtLeast(diff.omittedPaths, 1);
        }).pipe(Effect.provide(layer)),
      ),
  );

  it.effect("honours nested .gitignore files for new files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* repo;
        const inspection = yield* Inspection.WorkspaceInspection;
        yield* write(root, "pkg/.gitignore", "generated/\n");
        yield* sh(root, kind, ...(kind === "git" ? ["add", "-A"] : ["commit", "-m", "nested"]));
        if (kind === "git") yield* sh(root, "git", "commit", "-q", "-m", "nested");
        yield* write(root, "pkg/generated/out.txt", "zzunique\n");
        yield* write(root, "pkg/real.txt", "zzunique\n");
        const source = yield* inspection.observe(root);
        assert.deepStrictEqual(
          source.changes.map((change) => change.path),
          ["pkg/real.txt"],
        );
        const found = yield* inspection.search(root, {
          token: source.token,
          query: "zzunique",
          mode: "content",
        });
        assert.deepStrictEqual(
          found.matches.map((match) => match.path),
          ["pkg/real.txt"],
        );
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("refuses a search cursor replayed with another query shape", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* repo;
        const inspection = yield* Inspection.WorkspaceInspection;
        for (let index = 0; index < 3; index += 1)
          yield* write(root, `src/m${index}.ts`, "findme\n");
        const token = (yield* inspection.observe(root)).token;
        const first = yield* inspection.search(root, {
          token,
          query: "findme",
          mode: "content",
          limit: 1,
        });
        assert.strictEqual(
          yield* refusal(
            inspection.search(root, {
              token,
              query: "findme",
              mode: "content",
              pathPrefix: "src",
              cursor: first.nextCursor ?? "",
            }),
          ),
          "stale_source",
        );
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("notices a rewrite whose mtime was restored", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* repo;
        const fs = yield* FileSystem.FileSystem;
        const inspection = yield* Inspection.WorkspaceInspection;
        yield* write(root, "src/b.ts", "export const b = 3;\n");
        const info = yield* fs.stat(`${root}/src/b.ts`);
        const before = yield* inspection.observe(root);
        yield* write(root, "src/b.ts", "export const b = 4;\n");
        const modified = Option.getOrThrow(info.mtime);
        yield* fs.utimes(`${root}/src/b.ts`, modified, modified);
        assert.notStrictEqual((yield* inspection.observe(root)).token, before.token);
      }).pipe(Effect.provide(layer)),
    ),
  );
});

describe("recorded landing evidence", () => {
  const landed = (commitId: string, terminal: boolean) =>
    Layer.mock(SlipJayLandings.SlipJayLandings)({
      landingFor: () =>
        Effect.succeed({
          operationId: "op_1",
          status: terminal ? "landed" : "active",
          stage: "done",
          live: true,
        }),
      readDetail: () =>
        Effect.succeed({
          status: terminal ? "landed" : "running",
          stage: "done",
          terminal,
          commitId,
          checks: [{ command: "vp test", purpose: "gate", outcome: "passed", failingTests: [] }],
        }),
    });

  it.effect.each([
    ["the landing published this clean revision", true, "current"],
    ["the landing published other source", true, "stale"],
    ["the landing has not finished", false, "unverified"],
  ] as const)("labels evidence when %s", ([, terminal, expected]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* jjRepo;
        yield* write(root, "slipjay.json", '{"integrationBranch":"main"}');
        yield* sh(root, "jj", "commit", "-m", "config");
        const inspection = yield* Inspection.WorkspaceInspection;
        const source = yield* inspection.observe(root);
        const commit = expected === "stale" ? "0".repeat(40) : source.revision;
        const read = yield* inspection
          .evidence(root, source.token)
          .pipe(Effect.provide(landed(commit, terminal)));
        assert.strictEqual(read.evidence, "recorded");
        assert.strictEqual(read.sourceMatch, expected);
        assert.strictEqual(read.landing?.checks[0]?.outcome, "passed");
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("bounds the size of a landing record and says when it was cut", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* jjRepo;
        yield* write(root, "slipjay.json", '{"integrationBranch":"main"}');
        yield* sh(root, "jj", "commit", "-m", "config");
        const inspection = yield* Inspection.WorkspaceInspection;
        const source = yield* inspection.observe(root);
        const recorded = Array.from({ length: 30 }, (_, index) => ({
          command: `vp test ${index}`,
          purpose: "gate",
          outcome: "failed",
          failingTests: Array.from(
            { length: 20 },
            (_, test) => `suite ${index} > case ${test} ${"x".repeat(200)}`,
          ),
        }));
        const read = yield* inspection.evidence(root, source.token).pipe(
          Effect.provide(
            Layer.mock(SlipJayLandings.SlipJayLandings)({
              landingFor: () =>
                Effect.succeed({
                  operationId: "op_1",
                  status: "landed",
                  stage: "done",
                  live: true,
                }),
              readDetail: () =>
                Effect.succeed({
                  status: "landed",
                  stage: "done",
                  terminal: true,
                  commitId: source.revision,
                  checks: recorded,
                }),
            }),
          ),
        );
        assert.isTrue(read.truncated);
        assert.isBelow(read.landing?.checks.length ?? 0, recorded.length);
        assert.isAtMost(
          Buffer.byteLength(JSON.stringify(read.landing?.checks), "utf8"),
          Inspection.INSPECTION_LIMITS.responseBytes,
        );
        assert.isAtMost(read.landing?.checks[0]?.failingTests[0]?.length ?? 0, 200);
      }).pipe(Effect.provide(layer)),
    ),
  );

  it.effect("reports unavailable, never passed, when nothing was recorded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* jjRepo;
        const inspection = yield* Inspection.WorkspaceInspection;
        const source = yield* inspection.observe(root);
        const read = yield* inspection.evidence(root, source.token);
        assert.deepStrictEqual([read.evidence, read.sourceMatch], ["unavailable", "none"]);
      }).pipe(Effect.provide(layer)),
    ),
  );
});

describe("sensitive path policy", () => {
  it("denies credentials and runtime stores but keeps templates readable", () => {
    for (const path of [
      ".env",
      ".env.local",
      "apps/web/.env.production",
      "keys/server.pem",
      "home/.ssh/id_rsa",
      ".aws/credentials",
      ".t3/userdata/state.sqlite",
      "secrets/api.json",
      "terraform.tfstate",
      ".git/config",
      ".jj/repo/op_store",
    ])
      assert.isTrue(Inspection.isDeniedPath(path), path);
    for (const path of [".env.example", "src/env.ts", "docs/secrets-handling.md", "package.json"])
      assert.isFalse(Inspection.isDeniedPath(path), path);
  });
});
