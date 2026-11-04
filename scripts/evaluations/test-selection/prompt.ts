// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - Evaluation-only host script (wall-clock measurements, pacing and files); not Effect services.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ROOT } from "./baseline.ts";

export const RULES = {
  v1: {
    id: "test-relevance",
    version: "1",
    instruction:
      "Judge whether the named test file would plausibly FAIL, or need updating, because of the code change shown. Reason from what the test exercises (its titles and imports), not from the path alone. A test that merely imports the changed module without depending on the changed behaviour is not relevant.",
  },
  v2: {
    id: "test-relevance",
    version: "2",
    instruction:
      "Estimate the probability that this test file contains an assertion that the shown change would break. Consider the changed lines' behaviour and whether the test's titles describe that behaviour. Answer low when the test only shares a dependency with the changed module. Answer high only when the test's titles or imports tie it to the changed behaviour.",
  },
} as const;
export type RuleName = keyof typeof RULES;

export const CHUNK = 32;
const TITLE = /\b(?:describe|it|test)(?:\.[a-z]+)?\(\s*(["'`])((?:\\.|(?!\1).){3,120})\1/g;
const IMPORT = /from\s+["']([^"']+)["']/g;

export interface TestSummary {
  readonly path: string;
  readonly titles: ReadonlyArray<string>;
  readonly imports: ReadonlyArray<string>;
}

/** What the engine may know about a test: path, titles and import specifiers. Never its assertions. */
export function summarise(file: string, root = ROOT): TestSummary {
  let source = "";
  try {
    source = NodeFS.readFileSync(NodePath.join(root, file), "utf8");
  } catch {
    // An unreadable test is summarised by its path alone.
  }
  const titles = [...new Set([...source.matchAll(TITLE)].map((m) => m[2]!))].slice(0, 10);
  const imports = [...new Set([...source.matchAll(IMPORT)].map((m) => m[1]!))]
    .filter((s) => !s.startsWith("node:") && s !== "vitest" && !s.startsWith("@effect/vitest"))
    .slice(0, 12);
  return { path: file, titles, imports };
}

export interface ChunkItem {
  readonly file: string;
  readonly rank: number;
  readonly seconds: number | undefined;
}

export function buildRequest(
  engine: "jev" | "luna",
  rule: RuleName,
  change: { files: ReadonlyArray<string>; diff: string },
  items: ReadonlyArray<ChunkItem>,
) {
  const evidence = {
    change,
    tests: items.map((item, index) => ({
      id: `t${index}`,
      ...summarise(item.file),
      recordedWorkerSeconds: item.seconds ?? null,
    })),
  };
  return {
    engine,
    rule: { id: RULES[rule].id, version: RULES[rule].version },
    evidence: JSON.stringify(evidence),
    questions: items.map((_, index) => ({
      id: `t${index}`,
      type: "predicate" as const,
      instructions: `${RULES[rule].instruction} The test is t${index} in the evidence.`,
    })),
  };
}
