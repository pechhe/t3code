import type {
  PreviewAutomationSnapshot,
  PreviewTaskBinding,
  PreviewTaskCheck,
  PreviewTaskCheckResult,
  PreviewTaskTarget,
} from "@t3tools/contracts";

import { TASK_SNAPSHOT_TEXT_LENGTH } from "../preview/ServerBrowserPage.ts";

export interface PageNode {
  readonly role: string;
  readonly name: string;
  readonly ref: string | undefined;
  readonly parent: number | null;
  readonly checked: boolean;
  /** The text after a line's attributes: a field's current value. */
  readonly value: string | undefined;
  readonly selected: boolean;
}

export interface PageModel {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly nodes: readonly PageNode[];
  /** A cut snapshot cannot establish absence or uniqueness. */
  readonly truncated: boolean;
}

const LINE = /^([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?((?: \[[^\]]*\])*)(?:: ?(.*))?$/;
const REF = /\[ref=([^\]]+)\]/;

/** Playwright single-quotes a YAML key containing `: `, doubling any quote inside it. */
const unquote = (content: string) => {
  if (!content.startsWith("'")) return content;
  const closed = /'(:.*)?$/.exec(content);
  const end = closed?.index ?? content.length;
  return `${content.slice(1, end).replaceAll("''", "'")}${closed?.[1] ?? ""}`;
};

export const pageModelFromSnapshot = (snapshot: PreviewAutomationSnapshot): PageModel => {
  const tree = typeof snapshot.accessibilityTree === "string" ? snapshot.accessibilityTree : "";
  const nodes: PageNode[] = [];
  const open: Array<{ readonly indent: number; readonly index: number }> = [];
  for (const line of tree.split("\n")) {
    const dash = /^(\s*)- (.*)$/.exec(line);
    if (dash === null) continue;
    const indent = dash[1]!.length;
    const parsed = LINE.exec(unquote(dash[2]!));
    if (parsed === null) continue;
    while (open.length > 0 && open.at(-1)!.indent >= indent) open.pop();
    nodes.push({
      role: parsed[1]!,
      name: parsed[2] === undefined ? "" : (JSON.parse(parsed[2]) as string),
      ref: REF.exec(parsed[3] ?? "")?.[1],
      parent: open.at(-1)?.index ?? null,
      checked: /\[checked\]/.test(parsed[3] ?? ""),
      selected: /\[selected\]/.test(parsed[3] ?? ""),
      value: parsed[4] || undefined,
    });
    open.push({ indent, index: nodes.length - 1 });
  }
  return {
    url: snapshot.url,
    title: snapshot.title,
    text: snapshot.visibleText,
    nodes,
    truncated:
      tree.length >= TASK_SNAPSHOT_TEXT_LENGTH ||
      snapshot.visibleText.length >= TASK_SNAPSHOT_TEXT_LENGTH,
  };
};

export type TargetResolution =
  | { readonly _tag: "unique"; readonly node: PageNode }
  | { readonly _tag: "missing" }
  | { readonly _tag: "ambiguous"; readonly count: number }
  /** The snapshot was cut, so neither absence nor uniqueness holds. `count` is what it did show. */
  | { readonly _tag: "unknown"; readonly count: number };

const inside = (model: PageModel, node: PageNode, ancestor: PageNode) => {
  for (let parent = node.parent; parent !== null; parent = model.nodes[parent]!.parent)
    if (model.nodes[parent] === ancestor) return true;
  return false;
};

const matching = (model: PageModel, role: string, name: string) =>
  model.nodes.filter((node) => node.ref !== undefined && node.role === role && node.name === name);

export const resolveTarget = (model: PageModel, target: PreviewTaskTarget): TargetResolution => {
  let found = matching(model, target.role, target.name);
  if (target.scope !== undefined) {
    const scopes = matching(model, target.scope.role, target.scope.name);
    if (scopes.length > 1) return { _tag: "ambiguous", count: scopes.length };
    const scope = scopes[0];
    found = scope === undefined ? [] : found.filter((node) => inside(model, node, scope));
  }
  if (model.truncated) return { _tag: "unknown", count: found.length };
  if (found.length === 0) return { _tag: "missing" };
  return found.length === 1
    ? { _tag: "unique", node: found[0]! }
    : { _tag: "ambiguous", count: found.length };
};

export const CONTROL_ROLES: Readonly<Record<PreviewTaskBinding["control"], readonly string[]>> = {
  text: ["textbox", "searchbox", "spinbutton"],
  select: ["combobox", "listbox"],
  checkbox: ["checkbox", "radio", "switch"],
};

const normalized = (text: string) => text.replace(/\s+/g, " ").trim();

const optionsOf = (model: PageModel, node: PageNode) => {
  const index = model.nodes.indexOf(node);
  return model.nodes.filter((child) => child.parent === index && child.role === "option");
};

export const selectableOptions = (model: PageModel, node: PageNode) =>
  optionsOf(model, node).map((option) => option.name);

export const fieldValue = (model: PageModel, node: PageNode) =>
  optionsOf(model, node).find((option) => option.selected)?.name ?? node.value;

export const bindingSatisfied = (
  model: PageModel,
  binding: PreviewTaskBinding,
  node: PageNode,
): boolean => {
  switch (binding.control) {
    case "text":
      return normalized(node.value ?? "") === normalized(binding.text);
    case "select":
      return fieldValue(model, node) === binding.option;
    case "checkbox":
      return node.checked === binding.checked;
  }
};

const evaluateTarget = (
  model: PageModel,
  check: Extract<PreviewTaskCheck, { kind: "target" }>,
): Omit<PreviewTaskCheckResult, "id"> => {
  const resolved = resolveTarget(model, check.target);
  if (check.expect === "absent") {
    if (resolved._tag === "missing") return { status: "passed" };
    if (resolved._tag === "unknown" && resolved.count === 0)
      return { status: "not-evaluated", detail: "A cut snapshot cannot establish absence." };
    return { status: "failed", detail: "The target is rendered." };
  }
  if (resolved._tag === "missing")
    return { status: "failed", detail: "The target is not rendered." };
  if (resolved._tag === "ambiguous")
    return { status: "failed", detail: `${resolved.count} elements match the target.` };
  if (resolved._tag === "unknown") {
    if (resolved.count === 0)
      return { status: "not-evaluated", detail: "The target is not in the cut snapshot." };
    return check.value === undefined && check.checked === undefined
      ? { status: "passed" }
      : { status: "not-evaluated", detail: "A cut snapshot cannot single out the target." };
  }
  const { node } = resolved;
  if (check.checked !== undefined) {
    if (!CONTROL_ROLES.checkbox.includes(node.role))
      return { status: "unsupported", detail: `A ${node.role} has no checked state.` };
    if (node.checked !== check.checked)
      return { status: "failed", detail: `The target is ${node.checked ? "" : "not "}checked.` };
  }
  if (check.value !== undefined) {
    if (!CONTROL_ROLES.text.includes(node.role) && !CONTROL_ROLES.select.includes(node.role))
      return { status: "unsupported", detail: `A ${node.role} has no field value.` };
    if (normalized(fieldValue(model, node) ?? "") !== normalized(check.value))
      return { status: "failed", detail: "The target's value differs." };
  }
  return { status: "passed" };
};

const evaluateCheck = (
  model: PageModel,
  check: PreviewTaskCheck,
): Omit<PreviewTaskCheckResult, "id"> => {
  switch (check.kind) {
    case "url": {
      const holds =
        (check.equals === undefined || model.url === check.equals) &&
        (check.includes === undefined || model.url.includes(check.includes));
      return holds ? { status: "passed" } : { status: "failed", detail: "The URL differs." };
    }
    case "text": {
      const found = model.text.includes(check.includes);
      if (check.expect === "present")
        return found
          ? { status: "passed" }
          : model.truncated
            ? { status: "not-evaluated", detail: "A cut snapshot cannot establish absence." }
            : { status: "failed", detail: "The text is not visible." };
      if (found) return { status: "failed", detail: "The text is visible." };
      return model.truncated
        ? { status: "not-evaluated", detail: "A cut snapshot cannot establish absence." }
        : { status: "passed" };
    }
    case "target":
      return evaluateTarget(model, check);
    case "artifact":
      return { status: "not-evaluated", detail: "Captured only after the other checks pass." };
  }
};

export const evaluateChecks = (
  model: PageModel,
  checks: readonly PreviewTaskCheck[],
): readonly PreviewTaskCheckResult[] =>
  checks.map((check) => ({ id: check.id, ...evaluateCheck(model, check) }));
