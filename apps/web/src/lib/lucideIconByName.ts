/* oxlint-disable eslint/no-restricted-imports -- Resolves saved project icons by name, so it needs the whole set. */
// Import lazily: one chunk avoids lucide-react/dynamic emitting about 1,900 icon chunks.
import * as Lucide from "lucide-react";
import type { LucideIcon } from "lucide-react";

const iconComponents = new Set<unknown>(Object.values(Lucide.icons));
const lucideExports: Record<string, unknown> = Lucide;

// Match Lucide export naming to resolve deprecated aliases saved by older overrides.
function toPascalName(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

// Lucide digit names can differ from this inverse; both forms resolve through toPascalName.
function toKebabName(pascalName: string): string {
  return (pascalName.match(/[A-Z][a-z]*|[0-9]+[a-z]*/g) ?? []).join("-").toLowerCase();
}

export const lucideIconNames: ReadonlyArray<string> = Object.keys(Lucide.icons).map(toKebabName);

// Lucide 1 removes every brand icon. Each name the retained version exported keeps its subject
// through the closest glyph the installed package still offers, so a saved project choice does
// not silently become the app's generic folder.
const SAVED_BRAND_GLYPHS: Readonly<Record<string, string>> = {
  chrome: "globe",
  chromium: "globe",
  codepen: "code-xml",
  codesandbox: "box",
  dribbble: "palette",
  facebook: "thumbs-up",
  figma: "pen-tool",
  framer: "frame",
  github: "git-branch",
  gitlab: "git-fork",
  instagram: "camera",
  linkedin: "briefcase",
  pocket: "bookmark",
  "rail-symbol": "train-front",
  slack: "hash",
  trello: "columns-3",
  twitch: "video",
  twitter: "message-circle",
  youtube: "play",
};

// 0.564.0 exported every brand as `<Brand>`, `<Brand>Icon` and `Lucide<Brand>`, so a saved name
// can be any of those spellings.
const savedIconReplacements = new Map<string, string>();
for (const [brand, glyph] of Object.entries(SAVED_BRAND_GLYPHS)) {
  for (const name of [brand, `${brand}-icon`, `lucide-${brand}`]) {
    savedIconReplacements.set(name, glyph);
  }
}

function iconForName(name: string): LucideIcon | undefined {
  const icon = lucideExports[toPascalName(name)];
  return iconComponents.has(icon) ? (icon as LucideIcon) : undefined;
}

export function lucideIconByName(name: string): LucideIcon | undefined {
  const icon = iconForName(name);
  if (icon) return icon;
  const replacement = savedIconReplacements.get(name);
  return replacement ? iconForName(replacement) : undefined;
}
