// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - one-off evidence builder, not server code
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HELDOUT_CASES } from "./corpusHeldout.ts";
import { TUNE_CASES } from "./corpusTune.ts";

/**
 * Objective outcome evidence for the authentic cases, taken from the real landed change and the commits after it.
 * No model sees this and no engine is scored against it as a label: it is a second, independent view of difficulty.
 * Rework after the change is not measured: later fixes to a shared, busy file cannot be attributed to the change.
 */
const REPO_PATH = {
  t3code: NodePath.resolve(import.meta.dirname, "../../../../.."),
  slipjay: NodePath.join(NodeOS.homedir(), "projects/slipjay"),
  "agent-config": NodePath.join(NodeOS.homedir(), "projects/agent-config"),
  yardsmith: NodePath.join(NodeOS.homedir(), "projects/yardsmith"),
  "odds-and-ends": NodePath.join(NodeOS.homedir(), "projects/odds-and-ends"),
} as const;

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
const isTest = (p: string) => /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.|\.testkit\./.test(p);

const out: Record<string, unknown> = {};
for (const c of [...TUNE_CASES, ...HELDOUT_CASES]) {
  if (c.source === undefined) continue;
  const cwd = REPO_PATH[c.source.repo];
  const full = git(cwd, "rev-parse", c.source.hash).trim();
  const rows = git(cwd, "show", "--numstat", "--format=", full)
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t") as [string, string, string]);
  const files = rows.map((r) => r[2]);
  const dirs = new Set(files.map((f) => f.split("/").slice(0, 2).join("/")));
  const date = git(cwd, "show", "-s", "--format=%cI", full).trim();
  out[c.id] = {
    repo: c.source.repo,
    commit: full,
    committedAt: date,
    files: rows.length,
    testFiles: files.filter(isTest).length,
    added: rows.reduce((n, r) => n + (Number(r[0]) || 0), 0),
    deleted: rows.reduce((n, r) => n + (Number(r[1]) || 0), 0),
    areas: dirs.size,
  };
}
NodeFS.writeFileSync(
  NodePath.join(import.meta.dirname, "results/outcomes.json"),
  `${JSON.stringify(out, null, 2)}\n`,
);
console.log(`wrote ${Object.keys(out).length} outcomes`);
