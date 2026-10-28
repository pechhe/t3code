import { describe, expect, it, vi } from "vite-plus/test";

/**
 * The 57 names lucide-react 0.564.0 exported and 1.61.0 does not: each brand's base name and
 * the `…Icon` and `Lucide…` spellings it also exported, with the glyph that keeps its subject.
 */
const REMOVED_BRAND_ICONS: Readonly<Record<string, string>> = {
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

const removedNames = Object.entries(REMOVED_BRAND_ICONS).flatMap(
  ([brand, glyph]) =>
    [
      [brand, glyph],
      [`${brand}-icon`, glyph],
      [`lucide-${brand}`, glyph],
    ] as const,
);

const toPascalName = (name: string) =>
  name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

// Stands in for a Lucide release without brand icons: it exports only the replacement glyphs and
// the project fallback. The `has` trap keeps the mock's missing exports undefined instead of
// throwing.
vi.mock("lucide-react", () => {
  const components = new Map(
    [...new Set([...Object.values(REMOVED_BRAND_ICONS), "folder-code"])].map((name) => [
      toPascalName(name),
      // One component per glyph, so a test can tell two replacements apart.
      () => null,
    ]),
  );
  const lucideExports: Record<string, unknown> = { icons: Object.fromEntries(components) };
  for (const [pascalName, component] of components) lucideExports[pascalName] = component;
  return new Proxy(lucideExports, { get: (target, key) => target[key as string], has: () => true });
});

const Lucide = await import("lucide-react");
const { lucideIconByName } = await import("./lucideIconByName");

describe("lucideIconByName saved brand icons", () => {
  it("covers every name the Lucide major removes, in each spelling it exported", () => {
    expect(removedNames).toHaveLength(57);
    for (const [name, glyph] of removedNames) {
      expect(lucideIconByName(name), name).toBe(Lucide[toPascalName(glyph) as "Globe"]);
    }
  });

  it("resolves a saved name through its compatibility entry once the export is gone", () => {
    expect(lucideIconByName("github")).toBe(Lucide.GitBranch);
  });

  it("resolves exported names as before and leaves unknown ones unresolved", () => {
    expect(lucideIconByName("globe")).toBe(Lucide.Globe);
    expect(lucideIconByName("folder-code")).toBe(Lucide.FolderCode);
    expect(lucideIconByName("not-a-lucide-icon")).toBeUndefined();
  });
});
