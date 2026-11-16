// @effect-diagnostics nodeBuiltinImport:off -- Exercises the standalone launcher at its native subprocess boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PI_READ_ONLY_SHELL_SOURCE } from "./readOnlyShellSource.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);

it.live("protects source and external paths while allowing scratch and ignored outputs", () =>
  Effect.promise(async () => {
    const fixture = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pi-shell-scratch-"));
    try {
      const cwd = NodePath.join(fixture, "checkout");
      const scratch = NodePath.join(fixture, "scratch");
      const outside = NodePath.join(fixture, "home");
      const launcher = NodePath.join(fixture, "launcher.py");
      await Promise.all([cwd, scratch, outside].map((path) => NodeFSP.mkdir(path)));
      await NodeFSP.writeFile(launcher, PI_READ_ONLY_SHELL_SOURCE);
      await execute("git", ["init", "--quiet", cwd]);
      await NodeFSP.writeFile(NodePath.join(cwd, "tracked"), "original");
      await NodeFSP.writeFile(NodePath.join(cwd, ".gitignore"), "ignored/\n.git/\n.jj/\nlink\n");
      await NodeFSP.mkdir(NodePath.join(cwd, "tracked-dir"));
      await NodeFSP.writeFile(NodePath.join(cwd, "tracked-dir/source"), "protected");
      await NodeFSP.appendFile(NodePath.join(cwd, ".gitignore"), "tracked-link\n");
      await execute("git", ["add", "tracked", "tracked-dir/source", ".gitignore"], { cwd });
      await NodeFSP.mkdir(NodePath.join(cwd, "ignored"));
      await NodeFSP.mkdir(NodePath.join(cwd, ".jj"));
      await NodeFSP.symlink(outside, NodePath.join(cwd, "link"));
      await NodeFSP.symlink(NodePath.join(cwd, "tracked-dir"), NodePath.join(cwd, "tracked-link"));
      const run = (command: string) =>
        execute("python3", [launcher, "--scratch", scratch, "--", "/bin/bash", "-c", command], {
          cwd,
        });
      await execute("python3", [launcher, "--probe"]);
      const denied = [
        "echo changed > tracked",
        "echo changed > tracked-link/source",
        "echo created > new-source",
        "truncate -s 0 tracked",
        "rm tracked",
        "mv tracked renamed",
        "ln tracked ignored/hardlink",
        "echo secret > .git/config",
        "echo secret > .jj/metadata",
        "echo secret > link/secret",
        `echo secret > '${outside}/secret'`,
      ];
      if (HostProcess.Platform.defaultValue() === "darwin") denied.push("chmod 777 tracked");
      for (const command of denied) {
        await expect(run(command), command).rejects.toThrow();
      }
      assert.equal(await NodeFSP.readFile(NodePath.join(cwd, "tracked"), "utf8"), "original");
      assert.equal(
        await NodeFSP.readFile(NodePath.join(cwd, "tracked-dir/source"), "utf8"),
        "protected",
      );
      assert.equal((await run("cat tracked")).stdout, "original");
      await run(
        'echo scratch > "$TMPDIR/output"; echo cache > ignored/output; echo null > /dev/null',
      );
      assert.equal(await NodeFSP.readFile(NodePath.join(scratch, "output"), "utf8"), "scratch\n");
      assert.equal(await NodeFSP.readFile(NodePath.join(cwd, "ignored/output"), "utf8"), "cache\n");
      await NodeFSP.mkdir(NodePath.join(cwd, "later"));
      await NodeFSP.appendFile(NodePath.join(cwd, ".gitignore"), "later/\n");
      await run("echo picked-up > later/output");
      assert.equal(
        await NodeFSP.readFile(NodePath.join(cwd, "later/output"), "utf8"),
        "picked-up\n",
      );
      const nonGit = await execute(
        "python3",
        [launcher, "--scratch", scratch, "--", "/bin/bash", "-c", 'echo ok > "$TMPDIR/non-git"'],
        { cwd: outside },
      );
      assert.equal(nonGit.stderr, "");
    } finally {
      await NodeFSP.rm(fixture, { recursive: true, force: true });
    }
  }),
);
