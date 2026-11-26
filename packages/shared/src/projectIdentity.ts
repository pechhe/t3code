import {
  repositoryGroupingKeyOf,
  type RepositoryIdentity,
  type ProjectIconColor,
} from "@t3tools/contracts";
import { projectMonogram } from "./projectMonogram.ts";

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

// The fork also splits camelCase names into words before upstream's monogram rules apply.
const forkMonogram = (projectName: string): string =>
  projectMonogram(normalizeProjectName(projectName).replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2"));

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
    monogram: forkMonogram(projectName),
    color: projectColor(projectName),
  };
}

export function weaveRepositoryKeyOf(project: {
  readonly weaveRepositoryKey?: string | null | undefined;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}): string | null {
  if (project.weaveRepositoryKey) return project.weaveRepositoryKey;
  if (!project.repositoryIdentity) return null;
  const parts = repositoryGroupingKeyOf(project.repositoryIdentity).split("/");
  return parts.length >= 3 ? parts.slice(1).join("/") : null;
}
