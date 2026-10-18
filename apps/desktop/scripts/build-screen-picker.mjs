import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The native compiler targets the actual host; this script has no Effect runtime.
const hostArch = process.arch;
// oxlint-disable-next-line t3code/no-global-process-runtime -- The picker library only exists on macOS.
const hostPlatform = process.platform;

const { values } = NodeUtil.parseArgs({
  options: { output: { type: "string" }, arch: { type: "string", default: hostArch } },
});

if (hostPlatform === "darwin") {
  const clangArchs = { arm64: ["arm64"], x64: ["x86_64"], universal: ["arm64", "x86_64"] }[
    values.arch
  ];
  if (clangArchs === undefined) throw new Error(`Unsupported macOS architecture: ${values.arch}`);
  const root = NodeURL.fileURLToPath(new URL("../../../native/screen-picker/", import.meta.url));
  const source = NodePath.resolve(root, "screen_picker.m");
  const output =
    values.output ?? NodePath.resolve(root, "build", values.arch, "libt3-screen-picker.dylib");
  const matchesArchitecture = (file) =>
    NodeChildProcess.execFileSync("lipo", ["-archs", file], { encoding: "utf8" })
      .trim()
      .split(/\s+/)
      .toSorted()
      .join(" ") === clangArchs.toSorted().join(" ");
  let current = false;
  try {
    current =
      NodeFS.statSync(output).mtimeMs >=
        Math.max(
          NodeFS.statSync(source).mtimeMs,
          NodeFS.statSync(NodeURL.fileURLToPath(import.meta.url)).mtimeMs,
        ) && matchesArchitecture(output);
  } catch {}
  if (!current) {
    NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    try {
      NodeChildProcess.execFileSync(
        "xcrun",
        [
          "clang",
          "-dynamiclib",
          "-fobjc-arc",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-mmacosx-version-min=12.0",
          ...clangArchs.flatMap((arch) => ["-arch", arch]),
          "-framework",
          "Foundation",
          // The picker needs macOS 14; older systems still load the library and skip it.
          "-weak_framework",
          "ScreenCaptureKit",
          source,
          "-o",
          temporary,
        ],
        { stdio: "inherit" },
      );
      NodeFS.renameSync(temporary, output);
    } finally {
      NodeFS.rmSync(temporary, { force: true });
    }
  }
}
