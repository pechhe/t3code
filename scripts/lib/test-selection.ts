// @effect-diagnostics nodeBuiltinImport:off - Pure path arithmetic, read by host-side scripts before any Effect service exists.
// Which tests a change reaches: shared by the landing gate's budget and `check:changed`, so a
// local pass cannot miss a test the gate runs.
import * as NodePath from "node:path";

export const stemOf = (file: string) => NodePath.posix.basename(file).replace(/\..*$/, "");
const withoutExtension = (file: string) => file.replace(/\.[cm]?[jt]sx?$/, "");

/** The extensionless repository paths an import of a changed file names, `./dir` included. */
export function changedModulePaths(changed: ReadonlyArray<string>) {
  return new Set(
    changed.flatMap((file) => [
      withoutExtension(file),
      ...(stemOf(file) === "index" ? [NodePath.posix.dirname(file)] : []),
    ]),
  );
}

// A relative specifier in any import, mock or dynamic import; a query only names a loader.
const RELATIVE_SPECIFIER = /["'](\.{1,2}\/[^"'\n?]+)(?:\?[^"'\n]*)?["']/g;

/**
 * The repository paths a file's relative specifiers name, without an extension. Package
 * specifiers are not followed: only the relative imports inside a workspace are direct.
 */
export function relativeImports(file: string, source: string) {
  return [...source.matchAll(RELATIVE_SPECIFIER)].map((match) =>
    withoutExtension(NodePath.posix.join(NodePath.posix.dirname(file), match[1]!)),
  );
}

export interface TestSource {
  readonly file: string;
  readonly source: string;
}

/**
 * The tests whose own relative imports name a changed file. The gate runs these whatever its
 * budget, so a change that breaks one fails there; a test beside the changed files misses an
 * importer in another directory.
 */
export function importerTests(
  candidates: ReadonlyArray<TestSource>,
  changed: ReadonlyArray<string>,
) {
  const modules = changedModulePaths(changed);
  return candidates
    .filter(({ file, source }) => relativeImports(file, source).some((path) => modules.has(path)))
    .map(({ file }) => file);
}
