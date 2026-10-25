import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { ProjectIconColor, type ProjectIconOverride } from "@t3tools/contracts";
import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import type { AppSymbolName } from "../components/ui/AppSymbol";

export type ProjectIconGlyph =
  | { readonly kind: "emoji"; readonly emoji: string }
  | { readonly kind: "monogram"; readonly text: string; readonly color: ProjectIconColor };

/** Hermes lacks Intl.Segmenter; fold combining marks into base characters instead. */
export function countGlyphs(text: string): number {
  return Array.from(text.replace(/\p{M}/gu, "")).length;
}

export function projectMonogram(projectName: string): string {
  const words =
    projectName
      .normalize("NFKC")
      .trim()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
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

export function projectMonogramColor(projectName: string): ProjectIconColor {
  const seed = projectName.normalize("NFKC").trim().toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % ProjectIconColor.literals.length;
  }
  return ProjectIconColor.literals[index] ?? "blue";
}

export function projectAutoMonogram(projectTitle: string): ProjectIconGlyph | null {
  if (!projectTitle.trim()) return null;
  return {
    kind: "monogram",
    text: projectMonogram(projectTitle),
    color: projectMonogramColor(projectTitle),
  };
}

export function resolveProjectIconGlyph(
  projectIcon: ProjectIconOverride | null | undefined,
  projectTitle: string,
): ProjectIconGlyph | null {
  switch (projectIcon?.kind) {
    case "emoji":
      return { kind: "emoji", emoji: projectIcon.emoji };
    case "monogram":
      return { kind: "monogram", text: projectIcon.text, color: projectIcon.color };
    case "lucide":
      return { kind: "monogram", text: projectMonogram(projectTitle), color: projectIcon.color };
    case undefined:
      return null;
  }
}

const SYMBOL_BY_LUCIDE_NAME: Partial<Record<string, AppSymbolName>> = {
  "message-square-dashed": "text.bubble",
};

export function resolveProjectIconSymbol(
  projectIcon: ProjectIconOverride | null | undefined,
): { readonly name: AppSymbolName; readonly color: ProjectIconColor } | null {
  if (projectIcon?.kind !== "lucide") return null;
  const name = SYMBOL_BY_LUCIDE_NAME[projectIcon.name];
  return name ? { name, color: projectIcon.color } : null;
}

export type ProjectChipIcon = { readonly kind: "favicon"; readonly uri: string } | ProjectIconGlyph;

export function resolveProjectChipIcon(
  project: {
    readonly title: string;
    readonly workspaceRoot: string;
    readonly projectIcon?: ProjectIconOverride | null;
  } | null,
  scratchWorkspaceRoot: string | null | undefined,
  faviconUrl: () => string | null,
): ProjectChipIcon | null {
  if (!project || isScratchProject(project, scratchWorkspaceRoot)) return null;
  const glyph = resolveProjectIconGlyph(project.projectIcon, project.title);
  if (glyph) return glyph;
  const url = faviconUrl();
  if (url && !isProjectFaviconFallbackUrl(url)) return { kind: "favicon", uri: url };
  return projectAutoMonogram(project.title);
}

const PROJECT_ICON_COLOR_CLASSES: Record<
  ProjectIconColor,
  {
    readonly text: string;
    readonly tint: string;
    readonly background: string;
    readonly divider: string;
  }
> = {
  gray: {
    text: "text-gray-500",
    tint: "accent-gray-500",
    background: "bg-gray-500/15",
    divider: "bg-gray-500/45",
  },
  red: {
    text: "text-red-500",
    tint: "accent-red-500",
    background: "bg-red-500/15",
    divider: "bg-red-500/45",
  },
  orange: {
    text: "text-orange-500",
    tint: "accent-orange-500",
    background: "bg-orange-500/15",
    divider: "bg-orange-500/45",
  },
  amber: {
    text: "text-amber-500",
    tint: "accent-amber-500",
    background: "bg-amber-500/15",
    divider: "bg-amber-500/45",
  },
  yellow: {
    text: "text-yellow-500",
    tint: "accent-yellow-500",
    background: "bg-yellow-500/15",
    divider: "bg-yellow-500/45",
  },
  lime: {
    text: "text-lime-500",
    tint: "accent-lime-500",
    background: "bg-lime-500/15",
    divider: "bg-lime-500/45",
  },
  green: {
    text: "text-green-500",
    tint: "accent-green-500",
    background: "bg-green-500/15",
    divider: "bg-green-500/45",
  },
  emerald: {
    text: "text-emerald-500",
    tint: "accent-emerald-500",
    background: "bg-emerald-500/15",
    divider: "bg-emerald-500/45",
  },
  teal: {
    text: "text-teal-500",
    tint: "accent-teal-500",
    background: "bg-teal-500/15",
    divider: "bg-teal-500/45",
  },
  cyan: {
    text: "text-cyan-500",
    tint: "accent-cyan-500",
    background: "bg-cyan-500/15",
    divider: "bg-cyan-500/45",
  },
  sky: {
    text: "text-sky-500",
    tint: "accent-sky-500",
    background: "bg-sky-500/15",
    divider: "bg-sky-500/45",
  },
  blue: {
    text: "text-blue-500",
    tint: "accent-blue-500",
    background: "bg-blue-500/15",
    divider: "bg-blue-500/45",
  },
  indigo: {
    text: "text-indigo-500",
    tint: "accent-indigo-500",
    background: "bg-indigo-500/15",
    divider: "bg-indigo-500/45",
  },
  violet: {
    text: "text-violet-500",
    tint: "accent-violet-500",
    background: "bg-violet-500/15",
    divider: "bg-violet-500/45",
  },
  purple: {
    text: "text-purple-500",
    tint: "accent-purple-500",
    background: "bg-purple-500/15",
    divider: "bg-purple-500/45",
  },
  fuchsia: {
    text: "text-fuchsia-500",
    tint: "accent-fuchsia-500",
    background: "bg-fuchsia-500/15",
    divider: "bg-fuchsia-500/45",
  },
  pink: {
    text: "text-pink-500",
    tint: "accent-pink-500",
    background: "bg-pink-500/15",
    divider: "bg-pink-500/45",
  },
  rose: {
    text: "text-rose-500",
    tint: "accent-rose-500",
    background: "bg-rose-500/15",
    divider: "bg-rose-500/45",
  },
};

export function projectIconColorClassNames(color: ProjectIconColor) {
  return PROJECT_ICON_COLOR_CLASSES[color];
}
