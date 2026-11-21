import type { FolderChange, FolderFile } from "./AgentConfigGit.ts";
import type { FolderFileContent } from "./championFolderCodec.ts";

export const CHAMPIONS_PREFIX = "champions/";

export interface FolderOnMain {
  /** `champions/<group>/<id>` */
  readonly path: string;
  readonly id: string;
  /** The folder's files, with paths relative to it. */
  readonly files: ReadonlyArray<FolderFile>;
  /** `.agents/champions/<id>` in the watched repository, when that holds the definition and learnings. */
  readonly definedIn?: string;
}

const managed = (relative: string) =>
  relative === "champion.md" ||
  relative === "metrics.json" ||
  /^(learnings|findings|readings)\/[^/]+$/.test(relative);

/** Files under each `champions/<group>/<id>/`, with paths relative to it, champion.md or not. */
export const filesByFolder = (
  files: ReadonlyArray<FolderFile>,
): ReadonlyMap<string, ReadonlyArray<FolderFile>> => {
  const folders = new Map<string, FolderFile[]>();
  for (const file of files) {
    const match = /^champions\/([^/]+)\/([^/]+)\/(.+)$/.exec(file.path);
    if (match === null) continue;
    const path = `champions/${match[1]}/${match[2]}`;
    const entries = folders.get(path) ?? [];
    entries.push({ ...file, path: match[3]! });
    folders.set(path, entries);
  }
  return folders;
};

/** Every `champions/<group>/<id>/` holding a champion.md; other files under champions/ are not Champions. */
export const foldersOnMain = (files: ReadonlyArray<FolderFile>): ReadonlyArray<FolderOnMain> =>
  [...filesByFolder(files)]
    .filter(([, entries]) => entries.some((file) => file.path === "champion.md"))
    .map(([path, entries]) => ({ path, id: path.split("/")[2]!, files: entries }))
    .toSorted((a, b) => a.path.localeCompare(b.path));

/** Readings and findings: what the runner writes after every check. */
export const isRecordFile = (relative: string) => /^(findings|readings)\/[^/]+$/.test(relative);

/**
 * Each `.agents/champions/<id>/` holding a champion.md in a project repository, joined with the
 * readings and findings agent-config keeps for it at `champions/<group>/<id>`.
 */
export const hostedFolders = (
  repository: string,
  files: ReadonlyArray<FolderFile>,
  agentConfig: ReadonlyMap<string, ReadonlyArray<FolderFile>>,
): ReadonlyArray<FolderOnMain> => {
  const folders = new Map<string, FolderFile[]>();
  for (const file of files) {
    const match = /^\.agents\/champions\/([^/]+)\/(.+)$/.exec(file.path);
    if (match === null || isRecordFile(match[2]!)) continue;
    const entries = folders.get(match[1]!) ?? [];
    entries.push({ ...file, path: match[2]! });
    folders.set(match[1]!, entries);
  }
  return [...folders]
    .filter(([, entries]) => entries.some((file) => file.path === "champion.md"))
    .map(([id, entries]) => {
      const path = `champions/${folderGroup(repository)}/${id}`;
      const records = (agentConfig.get(path) ?? []).filter((file) => isRecordFile(file.path));
      return { path, id, definedIn: `.agents/champions/${id}`, files: [...entries, ...records] };
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));
};

export const isManagedFile = managed;

/** What turns the folder on main into the rendered one; the Champion's own notes are never touched. */
export const folderChanges = (
  path: string,
  onMain: ReadonlyArray<FolderFile>,
  rendered: ReadonlyArray<FolderFileContent>,
): ReadonlyArray<FolderChange> => {
  const current = new Map(onMain.map((file) => [file.path, file.content]));
  const wanted = new Set(rendered.map((file) => file.path));
  return [
    ...rendered
      .filter((file) => current.get(file.path) !== file.content)
      .map((file) => ({ path: `${path}/${file.path}`, content: file.content })),
    ...onMain
      .filter((file) => managed(file.path) && !wanted.has(file.path))
      .map((file) => ({ path: `${path}/${file.path}`, content: null })),
  ];
};

/** The group a new folder goes in: the watched repository's name, as in `champions/yardsmith/<id>`. */
export const folderGroup = (repository: string) =>
  (repository.split("/").at(-1) ?? repository).toLowerCase().replace(/[^a-z0-9._-]+/g, "-") ||
  "shared";
