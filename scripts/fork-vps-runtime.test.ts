// @effect-diagnostics nodeBuiltinImport:off - Exercises the real deploy shell script with private runtime/service fixtures.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { describe, expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "fork runtime installation",
  () => {
    it.each(["absent", "older", "same", "failure"] as const)(
      "installs the runtime and reconciles a %s boot service",
      async (mode) => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-service-"));
        try {
          const home = NodePath.join(root, "home");
          const versions = NodePath.join(home, ".t3/runtime/versions");
          const bin = NodePath.join(root, "bin");
          const clone = NodePath.join(root, "clone");
          const version = "0.0.46-nightly.20261015.3145";
          const archive = NodePath.join(root, "archive");
          for (const path of [versions, bin, NodePath.join(clone, "scripts"), archive]) {
            await NodeFSP.mkdir(path, { recursive: true });
          }
          const script = NodePath.join(clone, "scripts/fork-vps-runtime.sh");
          await NodeFSP.copyFile(NodePath.join(import.meta.dirname, "fork-vps-runtime.sh"), script);
          await NodeFSP.writeFile(NodePath.join(bin, "git"), "#!/bin/sh\necho fixture-commit\n", {
            mode: 0o755,
          });
          await NodeFSP.writeFile(NodePath.join(bin, "systemctl"), '#!/bin/sh\ncat "$HOME/pid"\n', {
            mode: 0o755,
          });
          await NodeFSP.writeFile(NodePath.join(home, "pid"), "101\n");
          const log = NodePath.join(root, "calls");
          await NodeFSP.writeFile(log, "");
          await NodeFSP.writeFile(
            NodePath.join(archive, "t3"),
            `#!/bin/sh
printf '%s\\n' "$*" >> "$T3_TEST_LOG"
case "$2" in
 install)
  [ "$T3_TEST_MODE" != failure ] || exit 9
  [ "$T3_TEST_MODE" != older ] || echo 102 > "$HOME/pid"
  ;;
 restart) echo 103 > "$HOME/pid" ;;
esac
`,
            { mode: 0o755 },
          );
          await execFile("tar", [
            "-czf",
            NodePath.join(versions, `.fork-pending-${version}.tar.gz`),
            "-C",
            root,
            "archive",
          ]);
          await NodeFSP.writeFile(
            NodePath.join(versions, `.fork-pending-${version}.tar.gz.source`),
            "fixture-commit\n",
          );
          if (mode !== "absent") {
            await NodeFSP.mkdir(NodePath.join(home, ".config/systemd/user"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(home, ".config/systemd/user/t3code.service"),
              "fixture service\n",
            );
            await NodeFSP.mkdir(NodePath.join(versions, version));
            await NodeFSP.writeFile(NodePath.join(versions, version, "t3"), "old runtime\n");
          }
          const install = execFile("bash", [script, "install", version, "fixture-commit"], {
            env: {
              ...process.env,
              HOME: home,
              PATH: `${bin}:${process.env.PATH}`,
              T3_TEST_MODE: mode,
              T3_TEST_LOG: log,
            },
            timeout: 10000,
          });
          if (mode === "failure") {
            await expect(install).rejects.toMatchObject({ code: 9 });
          } else {
            await expect(install).resolves.toMatchObject({ stderr: "" });
          }
          const calls = (await NodeFSP.readFile(log, "utf8")).trim().split("\n").filter(Boolean);
          const base = `--base-dir ${home}/.t3`;
          expect(calls).toEqual(
            mode === "absent"
              ? []
              : mode === "failure"
                ? [`service install ${base}`]
                : mode === "older"
                  ? [`service install ${base}`, `service status ${base}`]
                  : [
                      `service install ${base}`,
                      `service restart ${base}`,
                      `service status ${base}`,
                    ],
          );
          expect(
            await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
          ).toBe(`${version}\n`);
          expect(
            await NodeFSP.readFile(NodePath.join(versions, version, ".fork-source"), "utf8"),
          ).toBe("fixture-commit\n");
          // The completion marker exists only once the service steps succeeded too.
          const active = NodeFSP.readFile(NodePath.join(versions, ".fork-active"), "utf8");
          if (mode === "failure") await expect(active).rejects.toThrow();
          else await expect(active).resolves.toBe(`${version} fixture-commit\n`);
          expect(await NodeFSP.readFile(NodePath.join(home, "pid"), "utf8")).toBe(
            mode === "older" ? "102\n" : mode === "same" ? "103\n" : "101\n",
          );
        } finally {
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      },
    );

    it("refuses a built runtime from a commit other than the selected one", async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-source-"));
      try {
        const home = NodePath.join(root, "home");
        const versions = NodePath.join(home, ".t3/runtime/versions");
        const clone = NodePath.join(root, "clone");
        const version = "0.0.46-nightly.20261015.3145";
        await NodeFSP.mkdir(versions, { recursive: true });
        await NodeFSP.mkdir(NodePath.join(clone, "scripts"), { recursive: true });
        const script = NodePath.join(clone, "scripts/fork-vps-runtime.sh");
        await NodeFSP.copyFile(NodePath.join(import.meta.dirname, "fork-vps-runtime.sh"), script);
        const pending = NodePath.join(versions, `.fork-pending-${version}.tar.gz`);
        await NodeFSP.writeFile(pending, "archive");
        await NodeFSP.writeFile(`${pending}.source`, "older-commit\n");
        await expect(
          execFile("bash", [script, "install", version, "selected-commit"], {
            env: { ...process.env, HOME: home },
            timeout: 10000,
          }),
        ).rejects.toMatchObject({ code: 1 });
        await expect(NodeFSP.stat(NodePath.join(versions, version))).rejects.toThrow();
        await expect(NodeFSP.stat(pending)).resolves.toBeTruthy();
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });
  },
);
