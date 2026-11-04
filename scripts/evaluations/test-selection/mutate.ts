import * as ts from "typescript-legacy";

import { seededRandom } from "./select.ts";

export interface Mutation {
  readonly file: string;
  /** 1-based line of the change. */
  readonly line: number;
  readonly operator: string;
  readonly before: string;
  readonly after: string;
}

interface Operator {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace: (match: string) => string;
}

// Semantic-flipping operators on a single line. They never touch comments or imports.
export const OPERATORS: ReadonlyArray<Operator> = [
  { name: "strict-equality", pattern: / === /, replace: () => " !== " },
  { name: "strict-inequality", pattern: / !== /, replace: () => " === " },
  { name: "and-to-or", pattern: / && /, replace: () => " || " },
  { name: "or-to-and", pattern: / \|\| /, replace: () => " && " },
  { name: "bool-true", pattern: /\btrue\b/, replace: () => "false" },
  { name: "bool-false", pattern: /\bfalse\b/, replace: () => "true" },
  { name: "gte-to-gt", pattern: / >= /, replace: () => " > " },
  { name: "lt-to-lte", pattern: / < /, replace: () => " <= " },
  { name: "plus-to-minus", pattern: /(?<=\w) \+ (?=\w)/, replace: () => " - " },
  {
    name: "number-increment",
    pattern: /\b(\d{1,4})\b(?=[,;)\s])/,
    replace: (m) => String(Number(m) + 1),
  },
];

const skippable = (line: string) => {
  const trimmed = line.trim();
  return (
    trimmed === "" ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("import ") ||
    trimmed.startsWith("export type") ||
    trimmed.startsWith("type ") ||
    trimmed.startsWith("interface ") ||
    /["'`].*(?:===|!==|&&|\|\|).*["'`]/.test(trimmed)
  );
};

export function parsesCleanly(file: string, source: string) {
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 },
  });
  return (result.diagnostics ?? []).length === 0;
}

/** Every syntactically valid single-line mutation of a source, in file order. */
export function mutationsOf(file: string, source: string): ReadonlyArray<Mutation> {
  const out: Mutation[] = [];
  source.split("\n").forEach((text, index) => {
    if (skippable(text)) return;
    for (const operator of OPERATORS) {
      const match = operator.pattern.exec(text);
      if (!match) continue;
      const after = text.replace(operator.pattern, operator.replace(match[0]!));
      const mutated = source.split("\n");
      mutated[index] = after;
      if (after !== text && parsesCleanly(file, mutated.join("\n")))
        out.push({ file, line: index + 1, operator: operator.name, before: text, after });
    }
  });
  return out;
}

/** A seeded sample of distinct lines. */
export function sampleMutations(all: ReadonlyArray<Mutation>, count: number, seed: number) {
  const random = seededRandom(seed);
  const byLine = new Map<number, Mutation[]>();
  for (const mutation of all)
    byLine.set(mutation.line, [...(byLine.get(mutation.line) ?? []), mutation]);
  const lines = [...byLine.keys()].toSorted((a, b) => a - b);
  const picked: Mutation[] = [];
  while (picked.length < count && lines.length > 0) {
    const line = lines.splice(Math.floor(random() * lines.length), 1)[0]!;
    const options = byLine.get(line)!;
    picked.push(options[Math.floor(random() * options.length)]!);
  }
  return picked.toSorted((a, b) => a.line - b.line);
}

export function applyMutation(source: string, mutation: Mutation) {
  const lines = source.split("\n");
  if (lines[mutation.line - 1] !== mutation.before)
    throw new Error("mutation no longer matches source");
  lines[mutation.line - 1] = mutation.after;
  return lines.join("\n");
}

/** The change a reviewer would see: the mutated line with surrounding context. */
export function hunkOf(source: string, mutation: Mutation, context = 12) {
  const lines = source.split("\n");
  const from = Math.max(0, mutation.line - 1 - context);
  const to = Math.min(lines.length, mutation.line + context);
  return lines
    .slice(from, to)
    .map((text, i) => {
      const n = from + i + 1;
      return n === mutation.line ? `-${text}\n+${mutation.after}` : ` ${text}`;
    })
    .join("\n");
}
