export interface RemoteProjectCandidate {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export type RemoteProjectChoice<Candidate extends RemoteProjectCandidate> =
  | { readonly _tag: "chosen"; readonly project: Candidate }
  | { readonly _tag: "none" }
  | { readonly _tag: "ambiguous"; readonly candidates: ReadonlyArray<Candidate> };

const folderName = (workspaceRoot: string) =>
  workspaceRoot
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase() ?? "";

/**
 * Which project there receives a moved thread, among those with its repository.
 * Several projects can share one repository, so a single match is not required:
 * the project with the same title wins, then the same folder name; what is
 * still tied is left for the person to choose.
 */
export function chooseRemoteProject<Candidate extends RemoteProjectCandidate>(
  matches: ReadonlyArray<Candidate>,
  here: { readonly title: string; readonly workspaceRoot: string } | undefined,
): RemoteProjectChoice<Candidate> {
  if (matches.length === 0) return { _tag: "none" };
  if (matches.length === 1) return { _tag: "chosen", project: matches[0]! };
  if (here !== undefined) {
    const title = here.title.trim().toLowerCase();
    const sameTitle = matches.filter((project) => project.title.trim().toLowerCase() === title);
    if (sameTitle.length === 1) return { _tag: "chosen", project: sameTitle[0]! };
    const pool = sameTitle.length > 1 ? sameTitle : matches;
    const folder = folderName(here.workspaceRoot);
    const sameFolder = pool.filter((project) => folderName(project.workspaceRoot) === folder);
    if (sameFolder.length === 1) return { _tag: "chosen", project: sameFolder[0]! };
    return { _tag: "ambiguous", candidates: sameFolder.length > 1 ? sameFolder : pool };
  }
  return { _tag: "ambiguous", candidates: matches };
}
