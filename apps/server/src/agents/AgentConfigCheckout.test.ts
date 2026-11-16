import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as AgentConfigCheckout from "./AgentConfigCheckout.ts";

const layer = ProcessRunner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ProcessRunner.ProcessRunner;
    const output = yield* processes.run({ command: "git", args, cwd, timeout: "30 seconds" });
    assert.equal(output.code, 0, output.stderr);
    return output.stdout.trim();
  });

const configure = (cwd: string) =>
  Effect.gen(function* () {
    yield* git(cwd, "config", "user.email", "test@example.com");
    yield* git(cwd, "config", "user.name", "Test");
  });

it.layer(layer)("AgentConfigCheckout", (it) => {
  it.effect("reports HEAD, uncommitted changes and the commits behind origin/main", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "agent-config-checkout-" });
      const remote = yield* fs.makeTempDirectoryScoped({ prefix: "agent-config-origin-" });
      yield* git(repo, "init", "-b", "main");
      yield* configure(repo);
      yield* fs.writeFileString(path.join(repo, "AGENTS.md"), "v1");
      yield* git(repo, "add", "AGENTS.md");
      yield* git(repo, "commit", "-m", "v1");
      const installed = yield* git(repo, "rev-parse", "HEAD");
      yield* git(remote, "init", "--bare", "-b", "main");
      yield* git(repo, "remote", "add", "origin", remote);
      yield* git(repo, "push", "origin", "HEAD:main");

      // Someone else pushes two commits to main; this checkout stays on v1.
      const other = yield* fs.makeTempDirectoryScoped({ prefix: "agent-config-other-" });
      yield* git(other, "clone", remote, ".");
      yield* configure(other);
      for (const version of ["v2", "v3"]) {
        yield* fs.writeFileString(path.join(other, "AGENTS.md"), version);
        yield* git(other, "commit", "-am", version);
      }
      yield* git(other, "push", "origin", "HEAD:main");
      yield* git(repo, "fetch", "origin");

      const clean = yield* AgentConfigCheckout.read(repo);
      assert.equal(clean.revision, installed);
      assert.equal(clean.workingCopyRevision, installed);
      assert.isFalse(clean.hasLocalChanges);
      assert.equal(yield* AgentConfigCheckout.commitsBehindMain(repo), 2);

      // An edit the checkout has not committed still counts as unlanded.
      yield* fs.writeFileString(path.join(repo, "AGENTS.md"), "local edit");
      assert.isTrue((yield* AgentConfigCheckout.read(repo)).hasLocalChanges);
    }).pipe(Effect.scoped),
  );

  it.effect("reloads rather than resaving a change another checkout already pushed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const remote = yield* fs.makeTempDirectoryScoped({ prefix: "agent-config-origin-" });
      yield* git(remote, "init", "--bare", "-b", "main");
      const clone = (prefix: string) =>
        Effect.gen(function* () {
          const dir = yield* fs.makeTempDirectoryScoped({ prefix });
          yield* git(dir, "clone", remote, ".");
          yield* configure(dir);
          yield* git(dir, "checkout", "-B", "main");
          return dir;
        });
      const seed = yield* clone("agent-config-seed-");
      yield* fs.makeDirectory(path.join(seed, "roles"));
      yield* fs.writeFileString(path.join(seed, "roles/policy.json"), "v1");
      yield* git(seed, "add", "roles/policy.json");
      yield* git(seed, "commit", "-m", "v1");
      yield* git(seed, "push", "origin", "HEAD:main");

      const first = yield* clone("agent-config-first-");
      const second = yield* clone("agent-config-second-");
      const firstBase = yield* AgentConfigCheckout.preparePolicy(first);
      yield* fs.writeFileString(path.join(first, "roles/policy.json"), "v2");
      assert.deepEqual(yield* AgentConfigCheckout.publishPolicy(first, "2", firstBase), {
        pushed: true,
        detail: null,
      });
      assert.equal(
        (yield* AgentConfigCheckout.preparePolicy(second).pipe(Effect.flip)).reason,
        "stale",
      );
      assert.equal(yield* fs.readFileString(path.join(second, "roles/policy.json")), "v2");
      assert.equal(
        yield* git(second, "rev-parse", "HEAD"),
        yield* git(remote, "rev-parse", "main"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reports an unavailable checkout as unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const plain = yield* fs.makeTempDirectoryScoped({ prefix: "agent-config-plain-" });
      assert.deepEqual(yield* AgentConfigCheckout.read(plain), {
        root: plain,
        revision: null,
        workingCopyRevision: null,
        hasLocalChanges: null,
      });
      assert.isNull(yield* AgentConfigCheckout.commitsBehindMain(plain));
    }).pipe(Effect.scoped),
  );
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "policy-publish-" });
  const root = `${directory}/local`;
  const other = `${directory}/other`;
  const remote = `${directory}/remote`;
  yield* fs.makeDirectory(root);
  yield* git(root, "init", "--bare", remote);
  yield* git(directory, "clone", remote, root);
  yield* git(root, "checkout", "-b", "main");
  yield* git(root, "config", "user.name", "Test");
  yield* git(root, "config", "user.email", "test@example.com");
  yield* fs.makeDirectory(`${root}/roles`);
  yield* fs.writeFileString(
    `${root}/roles/policy.json`,
    '{"revision":"policy.88","readers":"old"}\n',
  );
  yield* fs.writeFileString(`${root}/notes`, "original\n");
  yield* git(root, "add", ".");
  yield* git(root, "commit", "-m", "base");
  yield* git(root, "push", "origin", "main");
  yield* git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  yield* git(directory, "clone", remote, other);
  yield* git(other, "config", "user.name", "Test");
  yield* git(other, "config", "user.email", "test@example.com");
  return { root, other, remote };
});
const externalPolicy =
  '{"revision":"policy.89","readers":"old","note":"hand edit","council":true}\n';
const remoteEdit = Effect.fn("test.remoteEdit")(function* (
  other: string,
  policy: boolean | "deleted" = true,
) {
  const fs = yield* FileSystem.FileSystem;
  if (policy === "deleted") yield* fs.remove(`${other}/roles/policy.json`);
  else
    yield* fs.writeFileString(
      `${other}/${policy ? "roles/policy.json" : "elsewhere"}`,
      policy ? externalPolicy : "unrelated\n",
    );
  yield* git(other, "add", ".");
  yield* git(other, "commit", "-m", "hand edit");
  yield* git(other, "push", "origin", "main");
});
it.layer(layer)("policy publication concurrency", (it) => {
  it.effect.each([true, "deleted"] as const)(
    "refuses a stale checkout before saving when the remote policy is %s, preserving other files",
    (policy) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { root, other } = yield* fixture;
          yield* fs.writeFileString(`${root}/notes`, "pending\n");
          yield* fs.writeFileString(`${root}/untracked`, "keep\n");
          yield* remoteEdit(other, policy);
          expect((yield* AgentConfigCheckout.preparePolicy(root).pipe(Effect.flip)).reason).toBe(
            "stale",
          );
          if (policy === "deleted")
            expect(yield* fs.exists(`${root}/roles/policy.json`)).toBe(false);
          else expect(yield* fs.readFileString(`${root}/roles/policy.json`)).toBe(externalPolicy);
          expect(yield* fs.readFileString(`${root}/notes`)).toBe("pending\n");
          expect(yield* fs.readFileString(`${root}/untracked`)).toBe("keep\n");
          expect(yield* git(root, "rev-parse", "HEAD")).toBe(
            yield* git(other, "rev-parse", "HEAD"),
          );
        }),
      ),
  );

  it.effect.each([
    {
      handCommit: false,
      deleted: false,
      blockedFF: false,
      name: "drops only the unpublished Settings tip on raced divergence and preserves staged, unstaged and untracked files",
    },
    {
      handCommit: true,
      deleted: false,
      blockedFF: false,
      name: "leaves the checkout untouched when a hand commit follows the unpublished Settings commit",
    },
    {
      handCommit: false,
      deleted: true,
      blockedFF: false,
      name: "refuses a raced remote policy deletion without re-adding the file",
    },
    {
      handCommit: false,
      deleted: false,
      blockedFF: true,
      name: "reports attention without a commit after dropping the Settings tip when fast-forward fails",
    },
  ])("$name", ({ handCommit, deleted, blockedFF }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runner = yield* ProcessRunner.ProcessRunner;
        const { root, other, remote } = yield* fixture;
        if (blockedFF) {
          yield* fs.writeFileString(`${root}/local-commit`, "local\n");
          yield* git(root, "add", "local-commit");
          yield* git(root, "commit", "-m", "unrelated local commit");
        }
        const beforeHead = yield* git(root, "rev-parse", "HEAD");
        const beforePolicy = yield* fs.readFileString(`${root}/roles/policy.json`);
        const base = yield* AgentConfigCheckout.preparePolicy(root);
        yield* fs.writeFileString(
          `${root}/roles/policy.json`,
          '{"revision":"policy.89","readers":"new"}\n',
        );
        yield* fs.writeFileString(`${root}/notes`, "pending\n");
        yield* fs.writeFileString(`${root}/untracked`, "keep\n");
        yield* fs.writeFileString(`${root}/staged`, "staged\n");
        yield* git(root, "add", "staged");
        let injected = false;
        let settingsCommit = "";
        let headAfterHandCommit = "";
        let statusAfterHandCommit = "";
        const result = yield* AgentConfigCheckout.publishPolicy(root, "policy.89", base).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            ...runner,
            run: (request) =>
              Effect.gen(function* () {
                if (request.args?.includes("push") && !injected) {
                  injected = true;
                  settingsCommit = yield* git(root, "rev-parse", "HEAD");
                  yield* remoteEdit(other, deleted ? "deleted" : true);
                  if (handCommit) {
                    yield* fs.writeFileString(`${root}/hand`, "hand\n");
                    yield* git(root, "add", "hand");
                    yield* git(root, "commit", "--only", "-m", "hand commit", "--", "hand");
                    headAfterHandCommit = yield* git(root, "rev-parse", "HEAD");
                    statusAfterHandCommit = yield* git(root, "status", "--porcelain");
                  }
                }
                return yield* runner.run(request);
              }),
          }),
          Effect.flip,
        );
        expect(result.reason).toBe(handCommit || blockedFF ? "attention" : "stale");
        expect(yield* fs.readFileString(`${root}/notes`)).toBe("pending\n");
        expect(yield* fs.readFileString(`${root}/untracked`)).toBe("keep\n");
        expect(yield* git(root, "diff", "--cached", "--name-only")).toBe("staged");
        if (deleted)
          expect(yield* git(remote, "ls-tree", "main", "--", "roles/policy.json")).toBe("");
        else
          expect(yield* git(remote, "show", "main:roles/policy.json")).toBe(externalPolicy.trim());
        if (handCommit) {
          expect(result.commit).toBe(settingsCommit);
          expect(yield* git(root, "rev-parse", "HEAD")).toBe(headAfterHandCommit);
          expect(yield* git(root, "status", "--porcelain")).toBe(statusAfterHandCommit);
        } else if (blockedFF) {
          expect(result.commit).toBeUndefined();
          expect(yield* git(root, "rev-parse", "HEAD")).toBe(beforeHead);
          expect(yield* fs.readFileString(`${root}/roles/policy.json`)).toBe(beforePolicy);
          expect(yield* git(root, "diff", "HEAD", "--", "roles/policy.json")).toBe("");
        } else {
          if (deleted) expect(yield* fs.exists(`${root}/roles/policy.json`)).toBe(false);
          else expect(yield* fs.readFileString(`${root}/roles/policy.json`)).toBe(externalPolicy);
          expect(yield* git(root, "rev-parse", "HEAD")).toBe(
            yield* git(other, "rev-parse", "HEAD"),
          );
        }
      }),
    ),
  );
  it.effect("still rebases and publishes when the remote moved only in other files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { root, other, remote } = yield* fixture;
        const base = yield* AgentConfigCheckout.preparePolicy(root);
        yield* remoteEdit(other, false);
        const edited = '{"revision":"policy.89","readers":"new"}\n';
        yield* fs.writeFileString(`${root}/roles/policy.json`, edited);
        expect(yield* AgentConfigCheckout.publishPolicy(root, "policy.89", base)).toEqual({
          pushed: true,
          detail: null,
        });
        expect(yield* git(remote, "show", "main:roles/policy.json")).toBe(edited.trim());
        expect(yield* fs.readFileString(`${root}/elsewhere`)).toBe("unrelated\n");
      }),
    ),
  );
});
