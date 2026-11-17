// @effect-diagnostics nodeBuiltinImport:off - Plain-Node fork tooling with no Effect runtime, so the receipt verifier and the landing gate can each use it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const REMOVED_PATHS_FILE = "fork/removed-upstream-paths.json";

interface RemovedPathsFile {
  readonly paths: ReadonlyArray<string>;
}

/** The fork's checked-in list of upstream paths it deleted and must keep deleting. */
export function removedUpstreamPaths(repo: string): ReadonlyArray<string> {
  const path = NodePath.join(repo, REMOVED_PATHS_FILE);
  const parsed = JSON.parse(NodeFS.readFileSync(path, "utf8")) as RemovedPathsFile;
  return parsed.paths;
}

/** One glob to a matcher: `**` spans directories, `*` and `?` never cross a `/`. */
export function globMatcher(glob: string): (file: string) => boolean {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:[^/]+/)*");
  const expression = new RegExp(`^${pattern}$`);
  return (file) => expression.test(file);
}

/** The deepest directory a glob can reach into, so a walk never scans the whole checkout. */
function globRoot(glob: string): string {
  const segments = glob.split("/");
  const fixed: Array<string> = [];
  for (const segment of segments.slice(0, -1)) {
    if (segment === "**" || /[*?]/.test(segment)) break;
    fixed.push(segment);
  }
  return fixed.join("/");
}

/**
 * Working-tree files matching the list, which an upstream merge brought back. The walk reads the
 * checkout, not Git: the landing gate runs where Git may not be on PATH, and the list only ever
 * names source paths.
 */
export function removedPathFiles(
  repo: string,
  paths = removedUpstreamPaths(repo),
): ReadonlyArray<string> {
  const matchers = paths.map(globMatcher);
  const roots = [...new Set(paths.map(globRoot).filter((root) => root !== ""))];
  const found = new Set<string>();
  const walk = (relative: string) => {
    let entries;
    try {
      entries = NodeFS.readdirSync(NodePath.join(repo, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && matchers.some((matches) => matches(file))) found.add(file);
    }
  };
  for (const root of roots) walk(root);
  return [...found].sort();
}
