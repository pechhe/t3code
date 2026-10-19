#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - The gate is a synchronous host-side CLI over JJ, Vitest and the report directory.
//
// The landing gate's test step. It tests the exact rebased JJ candidate against its single
// integration parent and runs the tests that candidate can affect, within a time budget.
//
//   node scripts/test-landing.ts            select and run (what slipjay.json runs)
//   node scripts/test-landing.ts --plan     print the selection and stop
//   node scripts/test-landing.ts --audit    the complete suite, quarantined tests included (`pnpm test:audit`)
//   node scripts/test-landing.ts --commit <revision>   diagnostic: select for a commit against its parent
//   node scripts/test-landing.ts --replay [n]   select for the last n (30) first-parent integration commits
//   node scripts/test-landing.ts --durations <report-dir>   refresh tests/durations.json from an audit's reports
//
// Selection is Vitest's related-test graph in each affected test workspace, plus the explicit
// INPUT_RULES for tests whose inputs the import graph cannot see (files read from disk at
// runtime, source spawned in a child process). It fails closed: a change it cannot trace
// (toolchain, lockfile, Vitest config or setup, a deletion, a path with no mapping, an
// unreadable or ambiguous candidate) selects every workspace's complete suite. The budget then
// runs the selected tests nearest the change that fit LANDING_BUDGET and leaves the rest to the
// nightly audit. docs/operations/development.md#landing-gate documents the rules and the quarantine.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  BUILD_ONLY_EDGES,
  EXTRA_EDGES,
  INPUT_RULES,
  type InputRule,
} from "./lib/test-landing-inputs.ts";
import {
  listTests,
  mapConcurrently,
  runCommand,
  VITEST_FLAGS,
} from "./lib/test-landing-vitest.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const SHA = /^[0-9a-f]{40}$/;
const CODE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const WORKSPACE_MANIFEST =
  /^(?:(?:apps|packages|infra)\/[^/]+\/|scripts\/|oxlint-plugin-t3code\/)package\.json$/;
// Non-code files only reach a test through the import graph from these directories.
const GRAPH_DIRECTORIES = /^(?:src|test|tests|scripts|rules)\//;

// Anything here can change how every test runs, so the candidate runs the complete suite.
// Vitest loads `vite.config.*` and everything it imports before any test file, so those
// imports and the setup files are listed here too; test-landing.test.ts guards the list.
const GLOBAL = new RegExp(
  [
    // Toolchain, lockfile, and the gate's own inputs.
    String.raw`^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|slipjay\.json|t3\.json|\.node-version|\.nvmrc|vite\.config\.[cm]?[jt]s)$`,
    String.raw`^(?:\.vite-hooks|patches)\/`,
    String.raw`^(?:tests\/quarantine\.json|scripts\/test-landing\.ts|scripts\/lib\/test-landing-(?:inputs|replay)\.ts)$`,
    // Test setup, and what the Vitest configs import.
    String.raw`^apps\/web\/vite\/`,
    String.raw`^apps\/server\/src\/testUtils\/(?:gitConfig\.setup|weightedShardSequencer)\.ts$`,
    String.raw`^packages\/shared\/src\/(?:testing\/longTempDir|devProxy|HostProcess)\.ts$`,
    String.raw`^scripts\/lib\/(?:public-config|cli-external-packages|desktop-external-packages|third-party-licenses)\.ts$`,
    // Manifests, TypeScript and Vitest configuration, and setup files in any workspace.
    String.raw`(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|vite[^/]*\.config\.[cm]?[jt]s|vitest[^/]*\.[cm]?[jt]s|[^/]*\.setup\.[cm]?[jt]s)$`,
  ].join("|"),
);
// Paths no test reads. Mapped inputs below take precedence over this list. The fork receipt is
// checked by the gate's own `fork-upstream-receipt.ts verify`; its tests build temporary
// repositories. The durations only order and bound the selection.
const HARMLESS =
  /^(?:docs\/|\.agents\/|\.claude\/|\.cursor\/|\.vscode\/|\.devcontainer\/|\.macroscope\/|\.github\/|\.gitignore$|\.gitattributes$|\.env\.example$|LICENSE$|knip\.jsonc$|\.coderabbit\.config\.ts$|fork\/upstream-receipt\.json$|tests\/durations\.json$)|\.md$/;

const validPath = (file: string) =>
  file !== "" &&
  !NodePath.isAbsolute(file) &&
  !file.split("/").includes("..") &&
  !/[\n\r\t]/.test(file);

export interface LandingWorkspace {
  readonly name: string;
  readonly directory: string;
  /** Names of the workspace packages this one declares. */
  readonly dependencies: ReadonlyArray<string>;
  /** The `vp test run` flags of its `test` script; "opaque" when the script is not that shape. */
  readonly test: { readonly flags: ReadonlyArray<string> } | "opaque" | undefined;
}

export type LandingTests =
  | { readonly kind: "complete"; readonly reason: string }
  | {
      readonly kind: "related";
      readonly runs: ReadonlyArray<LandingRun>;
      readonly reasons: ReadonlyArray<string>;
    }
  | { readonly kind: "none"; readonly reasons: ReadonlyArray<string> };

export interface LandingRun {
  readonly directory: string;
  /** "related" runs `vp test related <files>`; "all" runs the workspace's complete suite. */
  readonly mode: "related" | "all";
  readonly files: ReadonlyArray<string>;
}

const isHarmless = (file: string) => HARMLESS.test(file);

function ownerOf(file: string, workspaces: ReadonlyArray<LandingWorkspace>) {
  let best: LandingWorkspace | undefined;
  for (const workspace of workspaces) {
    if (
      file.startsWith(`${workspace.directory}/`) &&
      (!best || workspace.directory.length > best.directory.length)
    ) {
      best = workspace;
    }
  }
  return best;
}

/** The workspace and everything that depends on it, through manifests and EXTRA_EDGES. */
function dependentClosure(directory: string, workspaces: ReadonlyArray<LandingWorkspace>) {
  const byDirectory = new Map(workspaces.map((workspace) => [workspace.directory, workspace]));
  const closure = new Set([directory]);
  for (const pending = [directory]; pending.length > 0;) {
    const current = byDirectory.get(pending.pop()!);
    for (const candidate of workspaces) {
      if (closure.has(candidate.directory)) continue;
      const declared =
        !!current &&
        candidate.dependencies.includes(current.name) &&
        !BUILD_ONLY_EDGES.some(
          ([from, to]) => from === candidate.directory && to === current.directory,
        );
      const extra = EXTRA_EDGES.some(
        ([from, to]) => from === candidate.directory && to === (current?.directory ?? directory),
      );
      if (declared || extra) {
        closure.add(candidate.directory);
        pending.push(candidate.directory);
      }
    }
  }
  return closure;
}

const complete = (reason: string): LandingTests => ({ kind: "complete", reason });

export function selectLandingTests(
  change: { readonly changed: ReadonlyArray<string>; readonly deleted: ReadonlyArray<string> },
  workspaces: ReadonlyArray<LandingWorkspace>,
  rules: ReadonlyArray<InputRule> = INPUT_RULES,
): LandingTests {
  const deleted = change.deleted.find((file) => !isHarmless(file));
  if (deleted !== undefined)
    return complete(`${deleted} was deleted; dependency edges are unavailable`);
  const files = new Set<string>();
  const fullSuites = new Set<string>();
  const reasons: string[] = [];
  for (const file of change.changed) {
    if (!validPath(file)) return complete(`${file} is not a repository-relative path`);
    if (GLOBAL.test(file)) return complete(`${file} can affect every test`);
    const mapped = rules.filter((rule) => rule.when.test(file));
    for (const rule of mapped) {
      rule.select?.forEach((entry) => files.add(entry));
      rule.workspaces?.forEach((directory) => fullSuites.add(directory));
      reasons.push(`${file}: ${rule.reason}`);
    }
    if (isHarmless(file)) continue;
    const owner = ownerOf(file, workspaces);
    if (
      owner &&
      (CODE.test(file) || GRAPH_DIRECTORIES.test(file.slice(owner.directory.length + 1)))
    ) {
      files.add(file);
      reasons.push(`${file}: import graph`);
    } else if (mapped.length === 0) {
      return complete(`${file} has no known dependency mapping`);
    }
  }
  const affected = new Set<string>();
  for (const file of files) {
    const owner = ownerOf(file, workspaces);
    if (!owner) return complete(`${file} belongs to no test workspace`);
    // A test file is an entry point; nothing imports it.
    for (const directory of TEST_FILE.test(file)
      ? [owner.directory]
      : dependentClosure(owner.directory, workspaces)) {
      affected.add(directory);
    }
  }
  const runs: LandingRun[] = [];
  for (const workspace of workspaces.toSorted((a, b) => a.directory.localeCompare(b.directory))) {
    if (!workspace.test) continue;
    if (
      fullSuites.has(workspace.directory) ||
      (affected.has(workspace.directory) && workspace.test === "opaque")
    ) {
      runs.push({ directory: workspace.directory, mode: "all", files: [] });
    } else if (affected.has(workspace.directory)) {
      runs.push({ directory: workspace.directory, mode: "related", files: [...files].toSorted() });
    }
  }
  return runs.length > 0 ? { kind: "related", runs, reasons } : { kind: "none", reasons };
}

/**
 * The gate's time limit, inside the verify budget in slipjay.json (p90 180 s) with room for the
 * typechecks and for listing the selection. The server suite is configured to run one file at a
 * time, which put a hub change at half an hour, so the gate and the audit run files in parallel
 * across a fixed number of workers.
 */
export const LANDING_BUDGET = { seconds: 60, workers: 8, startupSeconds: 5 } as const;
// About the median recorded file; a test added since the durations were recorded.
const UNRECORDED_SECONDS = 2;

export interface LandingTest {
  readonly directory: string;
  readonly file: string;
}

/**
 * Test file → seconds of worker time on the runner, imports included: its duration in the
 * audit's Vitest report plus its share of the run's time no file reported.
 */
export type Durations = Readonly<Record<string, number>>;

/** Estimated wall time: each workspace is one Vitest run, its files spread across the workers. */
export function estimateSeconds(tests: ReadonlyArray<LandingTest>, durations: Durations) {
  const runs = new Map<string, number[]>();
  for (const test of tests) {
    const costs = runs.get(test.directory) ?? [];
    costs.push(durations[test.file] ?? UNRECORDED_SECONDS);
    runs.set(test.directory, costs);
  }
  let total = 0;
  for (const costs of runs.values()) {
    const sum = costs.reduce((a, b) => a + b, 0);
    total += LANDING_BUDGET.startupSeconds + Math.max(...costs, sum / LANDING_BUDGET.workers);
  }
  return total;
}

const stemOf = (file: string) => NodePath.posix.basename(file).replace(/\..*$/, "");

/**
 * Runs the selected tests nearest the change that fit the budget, cheapest first within each
 * rank: a changed test (always, whatever its cost), a test named after a changed module, a test
 * beside a changed file, then the rest. The nightly audit runs what is deferred.
 */
export function budgetLandingTests(
  candidates: ReadonlyArray<LandingTest>,
  changed: ReadonlyArray<string>,
  durations: Durations,
  budgetSeconds: number = LANDING_BUDGET.seconds,
) {
  const changedFiles = new Set(changed);
  const changedDirectories = new Set(changed.map((file) => NodePath.posix.dirname(file)));
  const changedModules = new Set(
    changed.map((file) => `${NodePath.posix.dirname(file)}/${stemOf(file)}`),
  );
  const rank = ({ file }: LandingTest) =>
    changedFiles.has(file)
      ? 0
      : changedModules.has(`${NodePath.posix.dirname(file)}/${stemOf(file)}`)
        ? 1
        : changedDirectories.has(NodePath.posix.dirname(file))
          ? 2
          : 3;
  const cost = ({ file }: LandingTest) => durations[file] ?? UNRECORDED_SECONDS;
  const ordered = candidates.toSorted(
    (a, b) => rank(a) - rank(b) || cost(a) - cost(b) || a.file.localeCompare(b.file),
  );
  const selected: LandingTest[] = [];
  const deferred: LandingTest[] = [];
  for (const test of ordered) {
    if (rank(test) === 0 || estimateSeconds([...selected, test], durations) <= budgetSeconds) {
      selected.push(test);
    } else {
      deferred.push(test);
    }
  }
  return { selected, deferred, seconds: estimateSeconds(selected, durations) };
}

/**
 * Reads an audit's Vitest JSON reports (the manifest in its report directory). A file's cost is
 * its reported duration plus an even share of the worker time its run spent outside any file's
 * duration (imports, transforms and setup), which is most of a small file's cost. Vitest's file
 * times span only test bodies, so the run's own wall time, less the startup the estimate adds
 * per run, bounds the worker time.
 */
export function durationsFromReports(
  reports: ReadonlyArray<{
    readonly cwd: string;
    /** The run's wall time. */
    readonly seconds: number;
    readonly testResults: ReadonlyArray<{
      readonly name: string;
      readonly startTime: number;
      readonly endTime: number;
    }>;
  }>,
  root: string,
): Durations {
  const durations: Record<string, number> = {};
  for (const report of reports) {
    const files = report.testResults;
    if (files.length === 0) continue;
    const seconds = files.map((file) => Math.max(0, file.endTime - file.startTime) / 1000);
    const wall = Math.max(0, report.seconds - LANDING_BUDGET.startupSeconds);
    const busy = Math.min(files.length, LANDING_BUDGET.workers) * wall;
    const overhead = Math.max(0, busy - seconds.reduce((a, b) => a + b, 0)) / files.length;
    files.forEach((file, index) => {
      const path = NodePath.isAbsolute(file.name)
        ? NodePath.relative(root, file.name)
        : NodePath.join(report.cwd, file.name);
      durations[path.replaceAll("\\", "/")] = Math.round((seconds[index]! + overhead) * 10) / 10;
    });
  }
  return durations;
}

const SHELL_SYNTAX = /[&|;<>$`()]/;

/** Whether the gate's Vitest runner can reproduce these `vp test run` flags exactly. */
function reproducible(flags: ReadonlyArray<string>) {
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]!;
    if (flag === "--run" || flag === "--passWithNoTests") continue;
    if (!(VITEST_FLAGS as ReadonlyArray<string>).includes(flag) || !flags[index + 1]) return false;
    index++;
  }
  return true;
}

function parseWorkspace(directory: string, manifestText: string): LandingWorkspace {
  const manifest = JSON.parse(manifestText) as {
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  if (!manifest.name) throw new Error(`Unnamed workspace manifest: ${directory}/package.json`);
  const script = manifest.scripts?.test;
  const tokens = script?.trim().split(/\s+/) ?? [];
  const test =
    script === undefined
      ? undefined
      : tokens[0] === "vp" &&
          tokens[1] === "test" &&
          tokens[2] === "run" &&
          !SHELL_SYNTAX.test(script) &&
          reproducible(tokens.slice(3))
        ? { flags: tokens.slice(3).filter((flag) => flag !== "--run") }
        : ("opaque" as const);
  return {
    name: manifest.name,
    directory,
    dependencies: Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    }),
    test,
  };
}

/** Keeps only dependency names that name another workspace. */
export function readWorkspaces(
  tracked: ReadonlyArray<string>,
  readManifest: (path: string) => string,
): ReadonlyArray<LandingWorkspace> {
  const parsed = tracked
    .filter((file) => WORKSPACE_MANIFEST.test(file))
    .map((file) => parseWorkspace(file.slice(0, -"/package.json".length), readManifest(file)));
  const names = new Set(parsed.map((workspace) => workspace.name));
  return parsed.map((workspace) => ({
    ...workspace,
    dependencies: workspace.dependencies.filter((name) => names.has(name)),
  }));
}

/** A release bump: package.json differs only in its `version`, which no test reads. */
export function versionOnlyChange(before: string, after: string): boolean {
  try {
    const strip = (text: string) => {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      delete parsed.version;
      return JSON.stringify(parsed);
    };
    return strip(before) === strip(after);
  } catch {
    return false;
  }
}

/** The workspaces on disk, for a candidate JJ could not describe; it needs no JJ at all. */
function checkoutWorkspaces() {
  const manifests = [
    "scripts/package.json",
    "oxlint-plugin-t3code/package.json",
    ...["apps", "packages", "infra"].flatMap((directory) =>
      NodeFS.readdirSync(NodePath.join(ROOT, directory)).map(
        (name) => `${directory}/${name}/package.json`,
      ),
    ),
  ].filter((file) => NodeFS.existsSync(NodePath.join(ROOT, file)));
  return readWorkspaces(manifests, (file) =>
    NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8"),
  );
}

export type JjQuery = (args: ReadonlyArray<string>) => string;

const jj: JjQuery = (args) => {
  const result = NodeChildProcess.spawnSync("jj", ["--color=never", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`JJ query failed: ${result.stderr || result.error}`);
  return result.stdout;
};

function facts(query: JjQuery, revision: string) {
  const [candidate, parent, conflict, empty] = query([
    "log",
    "--no-graph",
    "-r",
    revision,
    "-T",
    'commit_id ++ "\\n" ++ parents.map(|p| p.commit_id()).join(" ") ++ "\\n" ++ conflict ++ "\\n" ++ empty',
  ])
    .trim()
    .split("\n");
  if (
    !candidate ||
    !SHA.test(candidate) ||
    !parent ||
    !SHA.test(parent) ||
    conflict !== "false" ||
    !["true", "false"].includes(empty ?? "")
  ) {
    throw new Error("Candidate must be conflict-free with exactly one parent");
  }
  return { candidate, parent, empty };
}

const trackedAt = (query: JjQuery, revision: string) => {
  const files = query(["file", "list", "--ignore-working-copy", "-r", revision])
    .trimEnd()
    .split("\n")
    .filter(Boolean);
  if (files.some((file) => !validPath(file))) throw new Error("Unsupported tracked path");
  return files;
};

/** What `revision` changed against `parent`, read from immutable JJ commits. */
export function changesBetween(query: JjQuery, parent: string, revision: string) {
  const current = new Set(trackedAt(query, revision));
  const before = trackedAt(query, parent);
  const deleted = before.filter((file) => !current.has(file));
  const show = (at: string, file: string) =>
    query(["file", "show", "--ignore-working-copy", "-r", at, file]);
  const diffed = query([
    "diff",
    "--ignore-working-copy",
    "--from",
    parent,
    "--to",
    revision,
    "-T",
    'json(path) ++ "\\n"',
  ])
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string);
  const beforeSet = new Set(before);
  const changed = [...new Set([...diffed, ...deleted])].filter(
    (file) =>
      !/(?:^|\/)package\.json$/.test(file) ||
      !current.has(file) ||
      !beforeSet.has(file) ||
      !versionOnlyChange(show(parent, file), show(revision, file)),
  );
  if (changed.some((file) => !validPath(file))) throw new Error("Unsupported changed path");
  const workspaces = readWorkspaces([...current], (file) => show(revision, file));
  return { changed, deleted, workspaces };
}

export function candidateChanges(
  query: JjQuery = jj,
  integrationBranch = (
    JSON.parse(NodeFS.readFileSync(NodePath.join(ROOT, "slipjay.json"), "utf8")) as {
      integrationBranch: string;
    }
  ).integrationBranch,
) {
  if (!/^[A-Za-z0-9._/-]+$/.test(integrationBranch)) throw new Error("Invalid integration branch");
  const working = facts(query, "@"); // Snapshots the working copy before the immutable reads.
  const integration = query([
    "log",
    "--ignore-working-copy",
    "--no-graph",
    "-r",
    integrationBranch,
    "-T",
    "commit_id",
  ]).trim();
  if (!SHA.test(integration)) throw new Error("Ambiguous integration bookmark");
  // An empty working copy continues a described candidate.
  const identity =
    working.empty === "true" && working.parent !== integration
      ? facts(query, working.parent)
      : working;
  if (identity.parent !== integration)
    throw new Error("Candidate is not rebased onto the single integration parent");
  const changes = changesBetween(query, identity.parent, identity.candidate);
  const assertUnchanged = () => {
    const after = facts(query, "@");
    const parent = query([
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-r",
      integrationBranch,
      "-T",
      "commit_id",
    ]).trim();
    if (
      after.candidate !== working.candidate ||
      after.parent !== working.parent ||
      parent !== integration
    ) {
      throw new Error("Candidate or integration parent changed during verification");
    }
  };
  assertUnchanged();
  return { candidate: identity.candidate, parent: identity.parent, ...changes, assertUnchanged };
}

/** An unreadable or ambiguous candidate is never narrowed. */
export function planCandidate(
  read: () => ReturnType<typeof candidateChanges>,
  rules: ReadonlyArray<InputRule> = INPUT_RULES,
) {
  try {
    const snapshot = read();
    return { snapshot, plan: selectLandingTests(snapshot, snapshot.workspaces, rules) };
  } catch (error) {
    return {
      snapshot: undefined,
      plan: complete(`candidate unreadable or ambiguous: ${String(error)}`),
    };
  }
}

export interface Quarantine {
  readonly file: string;
  readonly issue: number;
  readonly reason: string;
}

export function readQuarantine(text: string): ReadonlyArray<Quarantine> {
  const entries: unknown = JSON.parse(text);
  const invalid = (entry: unknown) =>
    !entry ||
    typeof entry !== "object" ||
    typeof (entry as Quarantine).file !== "string" ||
    !validPath((entry as Quarantine).file) ||
    !TEST_FILE.test((entry as Quarantine).file) ||
    !Number.isSafeInteger((entry as Quarantine).issue) ||
    (entry as Quarantine).issue <= 0 ||
    typeof (entry as Quarantine).reason !== "string" ||
    (entry as Quarantine).reason.trim() === "";
  if (!Array.isArray(entries) || entries.some(invalid)) {
    throw new Error(
      "Invalid tests/quarantine.json; each test needs an open Issue number and a reason",
    );
  }
  return entries as ReadonlyArray<Quarantine>;
}

export interface LandingReport {
  readonly format: "vitest-json";
  readonly path: string;
  readonly suite: string;
  readonly cwd: string;
  /** The run's wall time, added once it has run. */
  readonly seconds?: number;
}

export interface LandingCommand {
  readonly suite: string;
  readonly cwd: string;
  readonly command: ReadonlyArray<string>;
  readonly report?: LandingReport;
}

/**
 * Lists the planned runs' test files, leaves quarantined ones out and fits the rest to the
 * budget. A workspace whose test script the gate cannot read runs whole, outside the budget.
 */
export async function budgetedRuns(
  plan: LandingTests,
  workspaces: ReadonlyArray<LandingWorkspace>,
  changed: ReadonlyArray<string>,
  durations: Durations,
  quarantine: ReadonlyArray<Quarantine>,
  { root = ROOT, list = listTests }: { root?: string; list?: typeof listTests } = {},
) {
  const planned = plannedRuns(plan, workspaces);
  const flagsOf = (directory: string) =>
    workspaces.find((workspace) => workspace.directory === directory)?.test;
  const listable = planned.filter((run) => typeof flagsOf(run.directory) === "object");
  const listed = await mapConcurrently(
    listable,
    (run) => {
      const test = flagsOf(run.directory);
      return list({
        root,
        directory: run.directory,
        flags: typeof test === "object" ? test.flags : [],
        ...(run.mode === "related" ? { related: run.files } : {}),
      });
    },
    4,
  );
  const quarantined = new Set(quarantine.map((entry) => entry.file));
  const candidates = listed.flatMap((files, index) =>
    files
      .filter((file) => !quarantined.has(file))
      .map((file) => ({ directory: listable[index]!.directory, file })),
  );
  const budget = budgetLandingTests(candidates, changed, durations);
  // A whole suite that lists no tests runs anyway, so a configuration that stopped matching
  // its tests fails the gate as `vp test run` would, unless the workspace passes with none.
  const runs: TestRun[] = planned
    .filter(
      (run) =>
        !listable.includes(run) ||
        (run.mode === "all" && listed[listable.indexOf(run)]!.length === 0),
    )
    .map((run) => ({ directory: run.directory }));
  for (const directory of new Set(budget.selected.map((test) => test.directory))) {
    runs.push({
      directory,
      tests: budget.selected.filter((test) => test.directory === directory).map((t) => t.file),
    });
  }
  return { runs: runs.toSorted((a, b) => a.directory.localeCompare(b.directory)), ...budget };
}

/** A planned run per workspace: the complete plan runs every workspace's suite. */
export function plannedRuns(
  plan: LandingTests,
  workspaces: ReadonlyArray<LandingWorkspace>,
): ReadonlyArray<LandingRun> {
  if (plan.kind === "none") return [];
  return plan.kind === "related"
    ? plan.runs
    : workspaces
        .filter((workspace) => workspace.test)
        .map((workspace) => ({ directory: workspace.directory, mode: "all", files: [] }));
}

/** What a run executes: the listed test files, or the workspace's whole suite without them. */
export interface TestRun {
  readonly directory: string;
  readonly tests?: ReadonlyArray<string>;
}

/** One Vitest run per workspace; the gate leaves quarantined tests out of every run it makes. */
export function landingCommands(
  runs: ReadonlyArray<TestRun>,
  workspaces: ReadonlyArray<LandingWorkspace>,
  quarantine: ReadonlyArray<Quarantine>,
  reportDir?: string,
): ReadonlyArray<LandingCommand> {
  return runs.flatMap((run): LandingCommand[] => {
    const workspace = workspaces.find((candidate) => candidate.directory === run.directory);
    if (!workspace?.test) return [];
    const suite = workspace.name;
    const cwd = run.directory;
    if (workspace.test === "opaque") return [{ suite, cwd, command: ["pnpm", "run", "test"] }];
    const exclude = quarantine.flatMap((entry) =>
      entry.file.startsWith(`${run.directory}/`) ? [entry.file] : [],
    );
    const slug = run.directory.replaceAll("/", "-");
    const report: LandingReport | undefined = reportDir
      ? { format: "vitest-json", path: `vitest-${slug}.json`, suite, cwd }
      : undefined;
    const command = runCommand({
      root: ROOT,
      directory: run.directory,
      flags: workspace.test.flags,
      ...(run.tests ? { files: run.tests } : {}),
      ...(exclude.length > 0 ? { exclude } : {}),
      workers: LANDING_BUDGET.workers,
      ...(report ? { reportFile: NodePath.join(reportDir!, report.path) } : {}),
    });
    return [{ suite, cwd, command, ...(report ? { report } : {}) }];
  });
}

/**
 * Lists every report the runs will write, before they run, so a run that writes none is visible
 * as missing. Reports are best effort: a manifest that cannot be written never fails the gate.
 */
export function writeManifest(reportDir: string, reports: ReadonlyArray<LandingReport>) {
  try {
    NodeFS.writeFileSync(
      NodePath.join(reportDir, "slipjay-test-reports.json"),
      JSON.stringify({ version: 1, reports }),
    );
    return true;
  } catch (error) {
    console.warn("Test report manifest unavailable:", error);
    return false;
  }
}

async function run(args: ReadonlyArray<string>) {
  let reportDir = process.env.SLIPJAY_TEST_REPORT_DIR
    ? NodePath.resolve(process.env.SLIPJAY_TEST_REPORT_DIR)
    : undefined;
  if (reportDir) {
    try {
      NodeFS.mkdirSync(reportDir, { recursive: true });
    } catch (error) {
      console.warn("Test reports unavailable:", error);
      reportDir = undefined;
    }
  }
  const diagnostic = args.indexOf("--commit") >= 0 ? args[args.indexOf("--commit") + 1] : undefined;
  // The nightly audit runs the complete suite with quarantined tests included, with the same reports.
  const audit = args.includes("--audit");
  const { snapshot, plan } = audit
    ? { snapshot: undefined, plan: complete("audit") }
    : planCandidate(() => {
        if (diagnostic === undefined) return candidateChanges();
        const identity = facts(jj, diagnostic);
        return {
          ...identity,
          ...changesBetween(jj, identity.parent, identity.candidate),
          assertUnchanged: () => undefined,
        };
      });
  console.log(
    JSON.stringify(
      {
        candidate: snapshot?.candidate,
        parent: snapshot?.parent,
        changed: snapshot?.changed,
        selection: plan,
      },
      null,
      2,
    ),
  );
  const quarantine = audit
    ? []
    : readQuarantine(NodeFS.readFileSync(NodePath.join(ROOT, "tests/quarantine.json"), "utf8"));
  console.log("Landing quarantine exclusions:", JSON.stringify(quarantine));
  const workspaces = snapshot?.workspaces ?? checkoutWorkspaces();
  let runs: ReadonlyArray<TestRun> = plannedRuns(plan, workspaces);
  if (!audit && plan.kind !== "none") {
    const budget = await budgetedRuns(
      plan,
      workspaces,
      snapshot?.changed ?? [],
      readDurations(),
      quarantine,
    );
    runs = budget.runs;
    console.log(
      `Landing budget: ${budget.selected.length} test files, about ${Math.round(budget.seconds)}s ` +
        `of ${LANDING_BUDGET.seconds}s; ${budget.deferred.length} deferred to the nightly audit`,
    );
    if (budget.deferred.length > 0)
      console.log(`Deferred: ${budget.deferred.map((test) => test.file).join(" ")}`);
  }
  const commands = landingCommands(runs, workspaces, quarantine, reportDir);
  if (args.includes("--plan")) {
    console.log(
      commands.map((entry) => `$ (cd ${entry.cwd} && ${entry.command.join(" ")})`).join("\n"),
    );
    return 0;
  }
  if (reportDir) {
    const listed = commands.flatMap((entry) => (entry.report ? [entry.report] : []));
    if (!writeManifest(reportDir, listed)) {
      // Without a manifest the reports would be orphans; run without them.
      return runCommands(landingCommands(runs, workspaces, quarantine), snapshot);
    }
  }
  return runCommands(commands, snapshot, reportDir);
}

const DURATIONS = NodePath.join(ROOT, "tests/durations.json");

/** A missing or unreadable file only costs the budget its ordering; every test counts as unrecorded. */
function readDurations(): Durations {
  try {
    return JSON.parse(NodeFS.readFileSync(DURATIONS, "utf8")) as Durations;
  } catch (error) {
    console.warn("Test durations unavailable:", error);
    return {};
  }
}

/** Replaces the recorded durations of every file the reports cover. */
function recordDurations(reportDir: string) {
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(reportDir, "slipjay-test-reports.json"), "utf8"),
  ) as { reports: ReadonlyArray<LandingReport> };
  const reports = manifest.reports.flatMap((report) => {
    const path = NodePath.join(reportDir, report.path);
    if (report.seconds === undefined || !NodeFS.existsSync(path)) return [];
    const { testResults } = JSON.parse(NodeFS.readFileSync(path, "utf8")) as {
      testResults: ReadonlyArray<{ name: string; startTime: number; endTime: number }>;
    };
    return [{ cwd: report.cwd, seconds: report.seconds, testResults }];
  });
  const merged = { ...readDurations(), ...durationsFromReports(reports, ROOT) };
  const sorted = Object.fromEntries(
    Object.entries(merged)
      .filter(([file]) => NodeFS.existsSync(NodePath.join(ROOT, file)))
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );
  NodeFS.writeFileSync(DURATIONS, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Recorded ${Object.keys(sorted).length} test durations in tests/durations.json`);
}

function runCommands(
  commands: ReadonlyArray<LandingCommand>,
  snapshot: { readonly assertUnchanged: () => void } | undefined,
  reportDir?: string,
) {
  let exit = 0;
  const reports: LandingReport[] = [];
  for (const entry of commands) {
    console.log(`$ (cd ${entry.cwd} && ${entry.command.join(" ")})`);
    const started = Date.now();
    const status =
      NodeChildProcess.spawnSync(entry.command[0]!, entry.command.slice(1), {
        cwd: NodePath.join(ROOT, entry.cwd),
        stdio: "inherit",
      }).status ?? 1;
    const seconds = (Date.now() - started) / 1000;
    console.log(`landing tests ${entry.suite}: exit ${status} in ${seconds.toFixed(1)}s`);
    if (entry.report) reports.push({ ...entry.report, seconds });
    exit ||= status;
  }
  // The wall times calibrate `--durations`.
  if (reportDir) writeManifest(reportDir, reports);
  try {
    snapshot?.assertUnchanged();
  } catch (error) {
    console.error(error);
    exit = 1;
  }
  return exit;
}

/**
 * Replays the gate for each of the last `count` integration commits against its parent: what it
 * would select, run and defer, and the estimated time. No test body runs.
 */
async function replay(count: number) {
  const { replayLandings } = await import("./lib/test-landing-replay.ts");
  const { integrationBranch } = JSON.parse(
    NodeFS.readFileSync(NodePath.join(ROOT, "slipjay.json"), "utf8"),
  ) as { integrationBranch: string };
  const commits = jj([
    "log",
    "--ignore-working-copy",
    "--no-graph",
    "-r",
    `first_ancestors(${integrationBranch}, ${count})`,
    "-T",
    'commit_id ++ "\\n"',
  ])
    .trim()
    .split("\n");
  const durations = readDurations();
  const quarantine = readQuarantine(
    NodeFS.readFileSync(NodePath.join(ROOT, "tests/quarantine.json"), "utf8"),
  );
  await replayLandings({
    root: ROOT,
    commits: commits.toReversed(),
    pinned: commits[0]!,
    jj,
    budgetSeconds: LANDING_BUDGET.seconds,
    budget: ({ plan, workspaces, changed }, root) =>
      budgetedRuns(plan, workspaces, changed, durations, quarantine, { root }),
    plan: (commit) => {
      const tracked = trackedAt(jj, commit);
      try {
        const { parent } = facts(jj, commit);
        const changes = changesBetween(jj, parent, commit);
        return {
          plan: selectLandingTests(changes, changes.workspaces),
          workspaces: changes.workspaces,
          tracked,
          changed: changes.changed,
        };
      } catch (error) {
        const workspaces = readWorkspaces(tracked, (file) =>
          jj(["file", "show", "--ignore-working-copy", "-r", commit, file]),
        );
        return {
          plan: complete(`candidate unreadable or ambiguous: ${String(error)}`),
          workspaces,
          tracked,
          changed: [],
        };
      }
    },
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const index = args.indexOf("--replay");
  if (index >= 0) {
    await replay(Number(args[index + 1] ?? 30) || 30);
  } else if (args[0] === "--durations" && args[1]) {
    recordDurations(NodePath.resolve(args[1]));
  } else {
    process.exitCode = await run(args);
  }
}
