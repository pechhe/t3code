export const PI_READ_ONLY_SHELL_FILENAME = "pi-read-only-shell.py";

export const PI_READ_ONLY_SHELL_SOURCE = String.raw`import ctypes
import json
import os
import subprocess
import sys


def fail(reason):
    sys.exit("The read-only shell is unavailable on this host: " + reason)


def writable_roots(scratch):
    cwd = os.path.realpath(os.getcwd())
    roots = [scratch, "/dev/null"]
    try:
        result = subprocess.run(
            ["git", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
        )
        if result.returncode == 0:
            for entry in os.fsdecode(result.stdout).split("\0"):
                if not entry or os.path.islink(entry):
                    continue
                path = os.path.realpath(entry)
                relative = os.path.relpath(path, cwd)
                if (relative != "." and not relative.startswith(".." + os.sep)
                        and relative != ".." and not {".git", ".jj"}.intersection(relative.split(os.sep))
                        and os.path.exists(path)):
                    roots.append(path)
    except FileNotFoundError:
        pass
    return roots


def landlock(roots):
    libc = ctypes.CDLL(None, use_errno=True)
    create, add, restrict = 444, 445, 446
    abi = libc.syscall(create, None, 0, 1)
    # ABI 3 is the first version that can refuse truncation of protected files.
    if abi < 3:
        fail("Landlock ABI 3 or newer is required")
    write_file, truncate = 1 << 1, 1 << 14
    writes = write_file | sum(1 << bit for bit in range(4, 15))

    class PathBeneath(ctypes.Structure):
        _pack_ = 1
        _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

    attr = ctypes.c_uint64(writes)
    fd = libc.syscall(create, ctypes.byref(attr), ctypes.sizeof(attr), 0)
    if fd < 0:
        fail("Landlock create_ruleset: " + os.strerror(ctypes.get_errno()))
    for path in roots:
        pfd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        allowed = writes if os.path.isdir(path) else write_file | truncate
        rule = PathBeneath(allowed, pfd)
        if libc.syscall(add, fd, 1, ctypes.byref(rule), 0) != 0:
            fail("Landlock add_rule: " + os.strerror(ctypes.get_errno()))
        os.close(pfd)
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        fail("cannot set no_new_privs")
    if libc.syscall(restrict, fd, 0) != 0:
        fail("Landlock restrict_self: " + os.strerror(ctypes.get_errno()))
    os.close(fd)


def main():
    args = sys.argv[1:]
    probe = args == ["--probe"]
    if probe:
        roots, command = ["/dev/null"], ["/usr/bin/true"]
    else:
        if len(args) < 5 or args[0] != "--scratch" or args[2] != "--":
            fail("invalid launcher arguments")
        scratch = os.path.realpath(args[1])
        roots, command = writable_roots(scratch), args[3:]
        os.environ["TMPDIR"] = scratch
    if sys.platform == "linux":
        landlock(roots)
    elif sys.platform == "darwin":
        profile = "(version 1)(allow default)(deny file-write*)"
        for path in roots:
            kind = "subpath" if os.path.isdir(path) else "literal"
            profile += "(allow file-write* (" + kind + " " + json.dumps(path, ensure_ascii=False) + "))"
        command = ["/usr/bin/sandbox-exec", "-p", profile, *command]
    else:
        fail("unsupported operating system " + sys.platform)
    os.execvp(command[0], command)


try:
    main()
except Exception as error:
    fail(str(error))
`;

export const PI_READ_ONLY_SHELL_EXTENSION_SOURCE = String.raw`
let readOnlyShellReady: Promise<string> | undefined;
let readOnlyShellScratch: string | undefined;

function cleanReadOnlyShellScratch() {
  if (readOnlyShellScratch === undefined) return;
  NodeFS.rmSync(readOnlyShellScratch, { recursive: true, force: true });
  readOnlyShellScratch = undefined;
}

function readOnlyShellCommand(command: string): Promise<string> {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  readOnlyShellReady ??= (async () => {
    const extensionPath = env(EXTENSION_PATH_ENV);
    if (extensionPath === undefined) throw new Error("sandbox launcher path is missing");
    const launcher = NodePath.join(NodePath.dirname(extensionPath), READ_ONLY_SHELL_FILENAME);
    await new Promise<void>((resolve, reject) => {
      NodeChildProcess.execFile("python3", [launcher, "--probe"], (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve();
      });
    });
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pi-read-only-"));
    readOnlyShellScratch = scratch;
    process.once("exit", cleanReadOnlyShellScratch);
    return ["python3", launcher, "--scratch", scratch, "--", "/bin/bash", "-c"].map(quote).join(" ");
  })();
  return readOnlyShellReady.then((prefix) => prefix + " " + quote(command));
}
`;
