import {
  repositoryGroupingKeyOf,
  type RepositoryIdentity,
  type ProjectIconColor,
} from "@t3tools/contracts";

const PROJECT_ICON_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
] as const;

interface ProjectIdentity {
  readonly monogram: string;
  readonly color: ProjectIconColor;
}

function normalizeProjectName(projectName: string): string {
  return projectName.normalize("NFKC").trim();
}

function projectMonogram(projectName: string): string {
  const words = normalizeProjectName(projectName).match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return "PR";

  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}

function projectColor(projectName: string): ProjectIconColor {
  const seed = normalizeProjectName(projectName).toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % PROJECT_ICON_COLORS.length;
  }
  return PROJECT_ICON_COLORS[index] ?? "blue";
}

export function deriveProjectIdentity(projectName: string): ProjectIdentity {
  return {
    monogram: projectMonogram(projectName),
    color: projectColor(projectName),
  };
}

export function weaveRepositoryKeyOf(project: {
  readonly hqRepositoryKey?: string | null | undefined;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}): string | null {
  if (project.hqRepositoryKey) return project.hqRepositoryKey;
  if (!project.repositoryIdentity) return null;
  const parts = repositoryGroupingKeyOf(project.repositoryIdentity).split("/");
  return parts.length >= 3 ? parts.slice(1).join("/") : null;
}
