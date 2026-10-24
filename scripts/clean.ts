// @effect-diagnostics nodeBuiltinImport:off - Runs before dependencies exist, so it uses only Node built-ins.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MANIFEST = "pnpm-workspace.yaml";

// Every workspace package keeps its own generated tree, so these cover all of them.
const TARGETS = [
  "node_modules",
  "apps/*/node_modules",
  "packages/*/node_modules",
  "infra/*/node_modules",
  "oxlint-plugin-t3code/node_modules",
  "scripts/node_modules",
  "apps/*/dist",
  "apps/*/dist-electron",
  "packages/*/dist",
  ".vite-plus",
  "apps/*/.vite-plus",
  "packages/*/.vite-plus",
];

// The command this replaces was `rm -rf` run from the repository root. `vp run` hands a
// package script to the command without a shell, so those globs reached `rm` unexpanded
// and only the plain paths were ever removed. Globing here keeps every target, resolves
// against the repository that holds this script so it does not depend on the caller's
// directory, and leaves source, `.env` files and `.t3` runtime state alone.
const root = NodePath.dirname(import.meta.dirname);
if (!NodeFS.existsSync(NodePath.join(root, MANIFEST))) {
  throw new Error(`${root} is not a repository root: no ${MANIFEST}`);
}

for (const pattern of TARGETS) {
  for (const target of NodeFS.globSync(pattern, { cwd: root })) {
    // `rmSync` unlinks a symlink instead of walking into what it points at, so a linked
    // node_modules is removed and its target survives.
    NodeFS.rmSync(NodePath.join(root, target), { recursive: true, force: true });
  }
}
