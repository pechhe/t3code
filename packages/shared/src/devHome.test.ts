// @effect-diagnostics nodeBuiltinImport:off - builds real worktree layouts on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { resolveWorkspacePath, resolveWorkspaceT3Home } from "./devHome.ts";

const makeRepo = (
  kind:
    | "worktree"
    | "checkout"
    | "bare"
    | "submodule"
    | "unreadable-git-file"
    | "bare-repo-worktree"
    | "custom-common-dir-worktree",
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devhome-"));
      if (kind === "worktree") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
      } else if (kind === "bare-repo-worktree") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /srv/myrepo.git/worktrees/x\n");
      } else if (kind === "custom-common-dir-worktree") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /srv/store/worktrees/x\n");
      } else if (kind === "submodule") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: ../.git/modules/sub\n");
      } else if (kind === "unreadable-git-file") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "not a gitdir pointer\n");
      } else if (kind === "checkout") {
        NodeFS.mkdirSync(NodePath.join(root, ".git"));
      }
      const nested = NodePath.join(root, "apps", "web", "src");
      NodeFS.mkdirSync(nested, { recursive: true });
      return { root, nested };
    }),
    ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );

/**
 * The shape SlipJay leaves on a machine without a colocated git checkout: a
 * secondary jj workspace holds `.jj/repo` as a pointer file and has no `.git`.
 */
const makeJjWorkspace = (
  kind: "secondary" | "primary" | "malformed",
  options: { readonly underSlipJay?: boolean } = {},
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devhome-jj-"));
      const root = options.underSlipJay
        ? NodePath.join(base, ".slipjay", "workspaces", "t3-spare-abc123")
        : base;
      NodeFS.mkdirSync(NodePath.join(root, ".jj"), { recursive: true });
      if (kind === "secondary") {
        NodeFS.writeFileSync(NodePath.join(root, ".jj", "repo"), "../../shared/.jj/repo");
      } else if (kind === "primary") {
        NodeFS.mkdirSync(NodePath.join(root, ".jj", "repo"));
      }
      const nested = NodePath.join(root, "apps", "web", "src");
      NodeFS.mkdirSync(nested, { recursive: true });
      return { base, root, nested };
    }),
    ({ base }) => Effect.sync(() => NodeFS.rmSync(base, { recursive: true, force: true })),
  );

describe("resolveWorkspacePath", () => {
  it.effect(
    "finds a jj workspace root without a git file, from the root and a nested directory",
    () =>
      Effect.gen(function* () {
        const { root, nested } = yield* makeJjWorkspace("secondary");
        assert.equal(yield* resolveWorkspacePath(root), NodePath.resolve(root));
        assert.equal(yield* resolveWorkspacePath(nested), NodePath.resolve(root));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a primary jj workspace as a main checkout", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeJjWorkspace("primary");
      assert.equal(yield* resolveWorkspacePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("is not fooled by a primary .jj nested inside a secondary workspace", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeJjWorkspace("secondary");
      NodeFS.mkdirSync(NodePath.join(nested, ".jj", "repo"), { recursive: true });
      assert.equal(yield* resolveWorkspacePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds a colocated jj workspace whose .git file is not a worktree pointer", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeJjWorkspace("secondary");
      NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /store/.jj/repo/store/git\n");
      assert.equal(yield* resolveWorkspacePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses an unrecognisable .jj instead of falling back to the shared home", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeJjWorkspace("malformed");
      const error = yield* resolveWorkspacePath(nested).pipe(Effect.flip);
      assert.equal(error._tag, "AmbiguousAgentWorkspaceError");
      assert.include(error.message, "--base-dir");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a SlipJay workspace directory in which no workspace root is found", () =>
    Effect.gen(function* () {
      const { root } = yield* makeJjWorkspace("primary", { underSlipJay: true });
      const error = yield* resolveWorkspacePath(root).pipe(Effect.flip);
      assert.equal(error._tag, "AmbiguousAgentWorkspaceError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts a SlipJay workspace directory that is a jj workspace", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeJjWorkspace("secondary", { underSlipJay: true });
      assert.equal(yield* resolveWorkspacePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds a worktree root from a nested directory", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("worktree");
      assert.equal(yield* resolveWorkspacePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a main checkout as not a linked worktree", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("checkout");
      assert.equal(yield* resolveWorkspacePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a submodule as not a linked worktree", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeRepo("submodule");
      assert.equal(yield* resolveWorkspacePath(nested), undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finds a worktree of a bare repository", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("bare-repo-worktree");
      assert.equal(yield* resolveWorkspacePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("resolveWorkspaceT3Home", () => {
  it.effect("answers with the jj workspace's .t3", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeJjWorkspace("secondary");
      assert.equal(
        yield* resolveWorkspaceT3Home(nested),
        NodePath.join(NodePath.resolve(root), ".t3"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("answers with .t3 before the dev runner creates it", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("worktree");
      const home = yield* resolveWorkspaceT3Home(nested);
      assert.equal(home, NodePath.join(NodePath.resolve(root), ".t3"));
      assert.isFalse(NodeFS.existsSync(home ?? ""));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
