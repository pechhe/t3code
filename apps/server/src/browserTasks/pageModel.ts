import type {
  PreviewAutomationSnapshot,
  PreviewTaskBinding,
  PreviewTaskCheck,
  PreviewTaskCheckResult,
  PreviewTaskTarget,
} from "@t3tools/contracts";

import type { Mutable } from "effect/Types";
import { parse as parseYaml } from "yaml";

import { TASK_SNAPSHOT_TEXT_LENGTH } from "../preview/ServerBrowserPage.ts";

export interface PageNode {
  readonly role: string;
  readonly name: string;
  readonly ref: string | undefined;
  readonly parent: number | null;
  readonly checked: boolean;
  /** The node's text, inline or from its `- text:` children: a field's current value. */
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
  /** A loading page may still render what it lacks now. */
  readonly loading: boolean;
}

const KEY = /^([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?((?: \[[^\]]*\])*)$/;
const REF = /\[ref=([^\]]+)\]/;

/** One snapshot list item as Playwright wrote it: a YAML key, with its value when inline. */
const itemOf = (content: string) => {
  let item: unknown;
  try {
    item = parseYaml(content, { schema: "failsafe" });
  } catch {
    // A line cut by the snapshot's size limit.
    return undefined;
  }
  if (typeof item === "string") return { key: item, value: undefined };
  if (typeof item !== "object" || item === null) return undefined;
  const [entry] = Object.entries(item);
  if (entry === undefined) return undefined;
  return { key: entry[0], value: typeof entry[1] === "string" ? entry[1] : undefined };
};

export const pageModelFromSnapshot = (snapshot: PreviewAutomationSnapshot): PageModel => {
  const tree = typeof snapshot.accessibilityTree === "string" ? snapshot.accessibilityTree : "";
  const nodes: Array<Mutable<PageNode>> = [];
  const open: Array<{ readonly indent: number; readonly index: number }> = [];
  for (const line of tree.split("\n")) {
    const dash = /^(\s*)- (.*)$/.exec(line);
    if (dash === null) continue;
    const indent = dash[1]!.length;
    const item = itemOf(dash[2]!);
    const parsed = item === undefined ? null : KEY.exec(item.key);
    if (parsed === null) continue;
    while (open.length > 0 && open.at(-1)!.indent >= indent) open.pop();
    const parent = open.at(-1)?.index ?? null;
    const value = item!.value || undefined;
    nodes.push({
      role: parsed[1]!,
      name: parsed[2] === undefined ? "" : (JSON.parse(parsed[2]) as string),
      ref: REF.exec(parsed[3] ?? "")?.[1],
      parent,
      checked: /\[checked\]/.test(parsed[3] ?? ""),
      selected: /\[selected\]/.test(parsed[3] ?? ""),
      value,
    });
    // Playwright moves a node's text to `- text:` children once the node has properties, such
    // as a textbox's differing `/placeholder`.
    if (parsed[1] === "text" && value !== undefined && parent !== null) {
      const owner = nodes[parent]!;
      owner.value = (owner.value ?? "") + value;
    }
    open.push({ indent, index: nodes.length - 1 });
  }
  return {
    url: snapshot.url,
    title: snapshot.title,
    text: snapshot.visibleText,
    nodes,
    loading: snapshot.loading === true,
    truncated:
      tree.length >= TASK_SNAPSHOT_TEXT_LENGTH ||
      snapshot.visibleText.length >= TASK_SNAPSHOT_TEXT_LENGTH,
  };
};

export type TargetResolution =
  | { readonly _tag: "unique"; readonly node: PageNode }
  | { readonly _tag: "missing" }
  /** With `scope`, it is the ancestor that matched more than once. */
  | { readonly _tag: "ambiguous"; readonly count: number; readonly scope?: true }
  /** The snapshot was cut, so neither absence nor uniqueness holds. `count` is what it did show. */
  | { readonly _tag: "unknown"; readonly count: number };

/** A target's name or its scope's: exactly one of the two is given, which the request check enforces. */
export interface NameSpec {
  readonly name?: string | undefined;
  readonly nameIncludes?: string | undefined;
}

const normalized = (text: string) => text.replace(/\s+/g, " ").trim();

const nameMatches = (actual: string, spec: NameSpec) =>
  spec.nameIncludes === undefined
    ? actual === spec.name
    : normalized(actual).includes(normalized(spec.nameIncludes));

const inside = (model: PageModel, node: PageNode, ancestor: PageNode) => {
  for (let parent = node.parent; parent !== null; parent = model.nodes[parent]!.parent)
    if (model.nodes[parent] === ancestor) return true;
  return false;
};

const matching = (model: PageModel, role: string, spec: NameSpec) =>
  model.nodes.filter(
    (node) => node.ref !== undefined && node.role === role && nameMatches(node.name, spec),
  );

export const resolveTarget = (model: PageModel, target: PreviewTaskTarget): TargetResolution => {
  let found = matching(model, target.role, target);
  if (target.scope !== undefined) {
    const scopes = matching(model, target.scope.role, target.scope);
    if (scopes.length > 1) return { _tag: "ambiguous", count: scopes.length, scope: true };
    const scope = scopes[0];
    found = scope === undefined ? [] : found.filter((node) => inside(model, node, scope));
  }
  if (model.truncated) return { _tag: "unknown", count: found.length };
  if (found.length === 0) return { _tag: "missing" };
  return found.length === 1
    ? { _tag: "unique", node: found[0]! }
    : { _tag: "ambiguous", count: found.length };
};

const MAX_PAGE_NAME_CHARS = 120;

const pageName = (name: string) =>
  name.length > MAX_PAGE_NAME_CHARS ? `${name.slice(0, MAX_PAGE_NAME_CHARS)}…` : name;

/** What a `nameIncludes` target actually matched, so the caller can see which element was used. */
export const matchedName = (target: PreviewTaskTarget, node: PageNode) =>
  target.nameIncludes === undefined ? undefined : pageName(node.name);

export const CONTROL_ROLES: Readonly<Record<PreviewTaskBinding["control"], readonly string[]>> = {
  text: ["textbox", "searchbox", "spinbutton"],
  select: ["combobox", "listbox"],
  checkbox: ["checkbox", "radio", "switch"],
};

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
    const shown = resolved._tag === "unique" ? matchedName(check.target, resolved.node) : undefined;
    return {
      status: "failed",
      detail: "The target is rendered.",
      ...(shown === undefined ? {} : { matchedName: shown }),
    };
  }
  if (resolved._tag === "missing")
    return { status: "failed", detail: "The target is not rendered." };
  if (resolved._tag === "ambiguous")
    return {
      status: "failed",
      detail: `${resolved.count} ${resolved.scope ? "scopes" : "elements"} match the target.`,
    };
  if (resolved._tag === "unknown") {
    if (resolved.count === 0)
      return { status: "not-evaluated", detail: "The target is not in the cut snapshot." };
    return check.value === undefined && check.checked === undefined
      ? { status: "passed" }
      : { status: "not-evaluated", detail: "A cut snapshot cannot single out the target." };
  }
  const { node } = resolved;
  const matched = matchedName(check.target, node);
  const result = evaluateUnique(model, check, node);
  return matched === undefined ? result : { ...result, matchedName: matched };
};

const evaluateUnique = (
  model: PageModel,
  check: Extract<PreviewTaskCheck, { kind: "target" }>,
  node: PageNode,
): Omit<PreviewTaskCheckResult, "id"> => {
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

const MAX_NEAR_MATCHES = 3;

const editDistance = (a: string, b: string) => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
};

const describeNode = (node: PageNode) => `${node.role} "${pageName(node.name)}"`;

/** Ranked near misses of an exact name: outside the scope, another role or case, or a near spelling. */
const nearExact = (node: PageNode, target: PreviewTaskTarget, name: string) => {
  const wanted = name.toLowerCase();
  const allowed = Math.min(3, Math.max(1, Math.floor(wanted.length / 5)));
  const actual = node.name.toLowerCase();
  if (node.role === target.role && node.name === name) return 0;
  if (actual === wanted) return 1;
  if (node.role !== target.role || Math.abs(actual.length - wanted.length) > allowed)
    return undefined;
  const distance = editDistance(actual, wanted);
  return distance <= allowed ? 1 + distance : undefined;
};

/** Near misses of a fragment: outside the scope, under another role, or in another case. */
const nearFragment = (node: PageNode, target: PreviewTaskTarget, fragment: string) => {
  const actual = normalized(node.name);
  const wanted = normalized(fragment);
  if (actual.includes(wanted)) return node.role === target.role ? 0 : 1;
  return node.role === target.role && actual.toLowerCase().includes(wanted.toLowerCase())
    ? 1
    : undefined;
};

/** Hints for a missing target, labelled by the caller as page data. They never resolve it. */
export const nearMatches = (model: PageModel, target: PreviewTaskTarget): readonly string[] => {
  const near = model.nodes
    .filter((node) => node.ref !== undefined && node.name.length > 0)
    .flatMap((node) => {
      const rank =
        target.nameIncludes === undefined
          ? nearExact(node, target, target.name ?? "")
          : nearFragment(node, target, target.nameIncludes);
      return rank === undefined ? [] : [{ node, rank }];
    })
    .toSorted((a, b) => a.rank - b.rank);
  return [...new Set(near.map(({ node }) => describeNode(node)))].slice(0, MAX_NEAR_MATCHES);
};

/**
 * A missing target the page plainly lacks, rather than one still to come: its named scope is
 * absent, or, for an exact name, something near it is rendered instead. A fragment's near
 * matches never stop a run early: a short fragment often shows in a heading or toast while the
 * list it names is still loading.
 */
export const evidentAbsence = (
  model: PageModel,
  target: PreviewTaskTarget,
): { readonly nearest: readonly string[] } | undefined => {
  if (model.truncated || model.loading || resolveTarget(model, target)._tag !== "missing")
    return undefined;
  const scopeMissing =
    target.scope !== undefined && matching(model, target.scope.role, target.scope).length === 0;
  const nearest = nearMatches(model, target);
  if (scopeMissing || (target.nameIncludes === undefined && nearest.length > 0)) return { nearest };
  return undefined;
};
