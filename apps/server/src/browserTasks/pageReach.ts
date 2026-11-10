import type { PreviewTaskTarget } from "@t3tools/contracts";

import { originOf } from "../preview/taskFence.ts";

import {
  describeElement,
  inside,
  lineText,
  matchingAll,
  selectableOptions,
  type PageModel,
  type PageNode,
} from "./pageModel.ts";

/** What only the page can tell: which text sits in a `position: fixed` layer, and each frame's URL. */
export interface PageFacts {
  /** Refs of probed text elements inside a fixed-position element. */
  readonly fixed: ReadonlySet<string>;
  /** An iframe's ref to its document's URL. */
  readonly frames: ReadonlyMap<string, string>;
}

export const NO_FACTS: PageFacts = { fixed: new Set(), frames: new Map() };

const CLICKABLE_ROLES = new Set([
  "link",
  "button",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "checkbox",
  "radio",
  "switch",
  "combobox",
]);
/** Jev writes no text, and a frame is reached through its contents. */
const NOT_CLICKABLE = new Set(["textbox", "searchbox", "spinbutton", "slider", "iframe"]);
const DIALOGS = new Set(["dialog", "alertdialog"]);
/** Text elements probed for a fixed layer per observation, nearest the viewport's edges first. */
const MAX_PROBED = 200;

const ancestorsOf = (model: PageModel, node: PageNode) => {
  const found: PageNode[] = [];
  for (let parent = node.parent; parent !== null; parent = model.nodes[parent]!.parent)
    found.push(model.nodes[parent]!);
  return found;
};

/** Its box meets the viewport. */
const inViewport = (model: PageModel, node: PageNode) => {
  const box = node.box;
  if (box === undefined || box.width <= 0 || box.height <= 0) return false;
  const viewport = model.viewport;
  if (viewport === undefined) return true;
  return (
    box.x < viewport.width &&
    box.x + box.width > 0 &&
    box.y < viewport.height &&
    box.y + box.height > 0
  );
};

/** A native select: chosen by its option labels, never by clicking an option. */
const isDropdown = (model: PageModel, node: PageNode) =>
  node.role === "combobox" && selectableOptions(model, node).length > 0;

/** Chromium shows a `<summary>` as a named generic leading its `<details>` group. */
const disclosure = (model: PageModel, node: PageNode) =>
  node.role === "generic" &&
  node.name !== "" &&
  node.parent !== null &&
  model.nodes[node.parent]!.role === "group" &&
  model.nodes.findIndex((other) => other.parent === node.parent) === model.nodes.indexOf(node);

/** A select's options are chosen through it; only an ARIA listbox's are clicked. */
const roleClickable = (model: PageModel, node: PageNode) =>
  CLICKABLE_ROLES.has(node.role) ||
  disclosure(model, node) ||
  (node.role === "option" &&
    ancestorsOf(model, node).find((up) => up.role === "listbox" || up.role === "combobox")?.role ===
      "listbox");

const textual = (node: PageNode) =>
  !NOT_CLICKABLE.has(node.role) && node.role !== "img" && lineText(node).length > 0;

const inDialog = (model: PageModel, node: PageNode) =>
  ancestorsOf(model, node).some((up) => DIALOGS.has(up.role));

const usable = (model: PageModel, node: PageNode) =>
  node.ref !== undefined && !node.disabled && inViewport(model, node);

const byPosition = (a: PageNode, b: PageNode) =>
  (a.box?.y ?? 0) - (b.box?.y ?? 0) || (a.box?.x ?? 0) - (b.box?.x ?? 0);

/** How far the element sits from the viewport's top or bottom edge, where fixed bars sit. */
const edgeDistance = (model: PageModel, node: PageNode) => {
  const box = node.box!;
  const height = model.viewport?.height ?? box.y + box.height;
  return Math.max(0, Math.min(box.y, height - box.y - box.height));
};

/** What to ask the page before candidates can be listed. */
export const pageReachProbe = (model: PageModel) => ({
  fixed: model.nodes
    .filter(
      (node) =>
        usable(model, node) &&
        !roleClickable(model, node) &&
        !node.pointer &&
        textual(node) &&
        !inDialog(model, node),
    )
    .toSorted((a, b) => edgeDistance(model, a) - edgeDistance(model, b) || byPosition(a, b))
    .slice(0, MAX_PROBED)
    .map((node) => node.ref!),
  frames: model.nodes.flatMap((node) =>
    node.role === "iframe" && node.ref !== undefined ? [node.ref] : [],
  ),
});

/** The origin of the document the element is in; an about: frame shares its parent's. */
const frameOrigin = (model: PageModel, node: PageNode, facts: PageFacts): string => {
  const frame = ancestorsOf(model, node).find((up) => up.role === "iframe");
  if (frame === undefined) return originOf(model.url);
  const url = frame.ref === undefined ? undefined : facts.frames.get(frame.ref);
  if (url === undefined) return "null";
  return /^about:/i.test(url) ? frameOrigin(model, frame, facts) : originOf(url);
};

/** The element is one of `fenced`, holds one or sits inside one. */
const touches = (model: PageModel, node: PageNode, fenced: ReadonlySet<PageNode>) =>
  fenced.has(node) ||
  ancestorsOf(model, node).some((up) => fenced.has(up)) ||
  [...fenced].some((match) => inside(model, match, node));

/** The element, an element it contains or one containing it matches an `avoid` entry. */
export const avoided = (
  model: PageModel,
  node: PageNode,
  avoid: readonly PreviewTaskTarget[],
): boolean => touches(model, node, new Set(avoid.flatMap((target) => matchingAll(model, target))));

export interface Candidate {
  readonly label: string;
  readonly node: PageNode;
  readonly description: string;
  readonly dropdown: boolean;
}

/**
 * Every visible, enabled control in an allowed frame, in viewport order: interactive roles, and
 * what the page makes clickable without one (a pointer cursor, or text in a dialog or fixed
 * layer). A role-less one is dropped when it holds a control or sits in another candidate.
 */
export const pageCandidates = (
  model: PageModel,
  facts: PageFacts,
  input: {
    readonly origins: ReadonlySet<string>;
    readonly avoid: readonly PreviewTaskTarget[];
    /** Never offered, nor anything holding or inside one: the explicit submit. */
    readonly excluded: readonly PageNode[];
    /** Already offered under the caller's own id. */
    readonly offered: ReadonlySet<PageNode>;
    readonly limit: number;
  },
): readonly Candidate[] => {
  // Matched once per observation: a full scan per entry, not per element.
  const off = new Set([
    ...input.avoid.flatMap((target) => matchingAll(model, target)),
    ...input.excluded,
  ]);
  const fenced = (node: PageNode) => touches(model, node, off);
  const strong = new Set<PageNode>();
  const weak = new Set<PageNode>();
  for (const node of model.nodes) {
    if (!usable(model, node) || input.offered.has(node)) continue;
    if (!input.origins.has(frameOrigin(model, node, facts)) || fenced(node)) continue;
    if (roleClickable(model, node)) strong.add(node);
    else if (
      (node.pointer && !NOT_CLICKABLE.has(node.role)) ||
      (textual(node) && (inDialog(model, node) || facts.fixed.has(node.ref!)))
    )
      weak.add(node);
  }
  const all = new Set([...strong, ...weak]);
  const kept = [
    ...strong,
    ...[...weak].filter(
      (node) =>
        !ancestorsOf(model, node).some((up) => all.has(up)) &&
        ![...strong].some((control) => inside(model, control, node)),
    ),
  ];
  return kept
    .toSorted(byPosition)
    .slice(0, Math.max(0, input.limit))
    .map((node, index) => {
      const dropdown = isDropdown(model, node);
      return {
        label: `P${index + 1}`,
        node,
        description: `${describeElement(model, node)}${dropdown ? " (dropdown)" : ""}`,
        dropdown,
      };
    });
};

/** The browser's own element ref, which outlives the per-snapshot prefix the server adds. */
const elementRef = (ref: string | undefined) => ref?.split("-").at(-1);

/** The node on a later snapshot of the same document that is this element, however renamed. */
export const laterNode = (model: PageModel, node: PageNode) =>
  model.nodes.find(
    (other) => other.ref !== undefined && elementRef(other.ref) === elementRef(node.ref),
  );

/** The same element on a later page: same role and name, still visible and enabled. */
export const sameElement = (model: PageModel, node: PageNode) => {
  const later = laterNode(model, node);
  return later !== undefined &&
    later.role === node.role &&
    later.name === node.name &&
    usable(model, later)
    ? later
    : undefined;
};
