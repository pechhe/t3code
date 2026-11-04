import type { PreviewAutomationSnapshot } from "@t3tools/contracts";

import type { ObservedElement, Observation, TargetOperation } from "./decisionEngine.ts";

const CLICKABLE = new Set([
  "button",
  "link",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "option",
  "treeitem",
]);
const TEXT_ROLES = new Set(["textbox", "searchbox", "spinbutton"]);
const SELECT_ROLES = new Set(["combobox", "listbox"]);

/** `option "S"` lines nested under the element's own tree line, in order. */
const optionsUnder = (tree: string, locator: string): string[] => {
  const ref = locator.replace(/^aria-ref=/, "");
  const lines = tree.split("\n");
  const start = lines.findIndex((line) => line.includes(`[ref=${ref}]`));
  if (start < 0) return [];
  const indent = lines[start]!.search(/\S/);
  const labels: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.search(/\S/) <= indent) break;
    const match = /^\s*- option "((?:[^"\\]|\\.)*)"/.exec(line);
    if (match) labels.push(match[1]!);
  }
  return labels;
};

const stateOf = (tree: string, locator: string, role: string): string | undefined => {
  const ref = locator.replace(/^aria-ref=/, "");
  const line = tree.split("\n").find((candidate) => candidate.includes(`[ref=${ref}]`)) ?? "";
  if (["checkbox", "radio", "switch"].includes(role))
    return /\[(checked|pressed)\]/.test(line) ? "checked" : "unchecked";
  const typed = /^\s*- (?:textbox|searchbox)[^:]*:\s*(.+)$/.exec(line);
  return typed?.[1];
};

/** Reduce a managed-browser snapshot to the closed, numbered action space an engine may choose from. */
export const observationFromSnapshot = (snapshot: PreviewAutomationSnapshot): Observation => {
  const tree = typeof snapshot.accessibilityTree === "string" ? snapshot.accessibilityTree : "";
  const elements: ObservedElement[] = [];
  for (const entry of snapshot.interactiveElements) {
    const role = entry.role ?? "";
    const operations: TargetOperation[] = [];
    if (TEXT_ROLES.has(role)) operations.push("TYPE_TEXT");
    else if (SELECT_ROLES.has(role)) operations.push("SELECT");
    else if (CLICKABLE.has(role)) operations.push("CLICK");
    if (operations.length === 0) continue;
    const index = `e${elements.length + 1}`;
    const options = operations.includes("SELECT")
      ? optionsUnder(tree, entry.selector).map((label, position) => ({
          index: `${index}_${position + 1}`,
          label,
        }))
      : undefined;
    const value = stateOf(tree, entry.selector, role);
    elements.push({
      index,
      ...(value ? { value } : {}),
      locator: entry.selector,
      role,
      name: entry.name,
      operations,
      ...(options ? { options } : {}),
    });
  }
  return { url: snapshot.url, title: snapshot.title, text: snapshot.visibleText, elements };
};
