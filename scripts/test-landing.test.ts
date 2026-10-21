// @effect-diagnostics nodeBuiltinImport:off - Reads the repository's tracked files and writes report fixtures to a temporary directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  budgetedRuns,
  budgetLandingTests,
  budgetSummary,
  candidateChanges,
  changesBetween,
  durationsFromReports,
  estimateSeconds,
  invariantGuards,
  LANDING_BUDGET,
  landingCommands as runCommands,
  planCandidate,
  plannedRuns,
  readQuarantine,
  readWorkspaces,
  relativeImports,
  selectLandingTests,
  versionOnlyChange,
  writeBudgetReports,
  writeManifest,
  type JjQuery,
  type LandingTests,
  type LandingWorkspace,
  type Quarantine,
} from "./test-landing.ts";
import {
  BUILD_ONLY_EDGES,
  EXTRA_EDGES,
  INPUT_RULES,
  INVARIANT_GUARDS,
} from "./lib/test-landing-inputs.ts";
import { runCommand, type RunRequest } from "./lib/test-landing-vitest.ts";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");

const workspace = (
  directory: string,
  name: string,
  dependencies: ReadonlyArray<string> = [],
  test: LandingWorkspace["test"] = { flags: ["--config", "../../vite.config.ts", "--dir", "."] },
): LandingWorkspace => ({ name, directory, dependencies, test });

// shared <- client-runtime <- web; shared <- server; marketing stands alone.
const FIXTURE: ReadonlyArray<LandingWorkspace> = [
  workspace("packages/shared", "@t3tools/shared"),
  workspace("packages/contracts", "@t3tools/contracts"),
  workspace("packages/client-runtime", "@t3tools/client-runtime", ["@t3tools/shared"], {
    flags: [],
  }),
  workspace("apps/server", "t3", ["@t3tools/shared", "@t3tools/contracts"], { flags: [] }),
  workspace("apps/web", "@t3tools/web", ["@t3tools/client-runtime"], {
    flags: ["--passWithNoTests", "--project", "unit", "--project", "browser"],
  }),
  { name: "@t3tools/marketing", directory: "apps/marketing", dependencies: [], test: undefined },
];

// The fixture has no input rules: those name the real workspaces.
const select = (changed: ReadonlyArray<string>, deleted: ReadonlyArray<string> = []) =>
  selectLandingTests({ changed, deleted }, FIXTURE, []);

// The commands for a plan's runs, each over the workspace's whole suite.
const landingCommands = (
  plan: LandingTests,
  workspaces: ReadonlyArray<LandingWorkspace>,
  quarantine: ReadonlyArray<Quarantine>,
  reportDir?: string,
) => runCommands(plannedRuns(plan, workspaces), workspaces, quarantine, reportDir);

// What a gate command asks the Vitest runner to do.
const request = (command: { readonly command: ReadonlyArray<string> }): RunRequest =>
  JSON.parse(command.command.at(-1)!) as RunRequest;

const directories = (plan: ReturnType<typeof select>) =>
  plan.kind === "related" ? plan.runs.map((run) => run.directory) : [];

/** Every tracked-looking file under the workspaces, as the disk has it. */
function walk(directory: string, found: string[] = []): string[] {
  for (const entry of NodeFS.readdirSync(NodePath.join(REPOSITORY_ROOT, directory), {
    withFileTypes: true,
  })) {
    if (
      [
        "node_modules",
        "dist",
        "dist-electron",
        ".t3",
        ".git",
        ".jj",
        ".turbo",
        ".vite-plus",
      ].includes(entry.name)
    )
      continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walk(path, found);
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

const repositoryFiles = () =>
  ["apps", "packages", "infra", "scripts", "oxlint-plugin-t3code"].flatMap((directory) =>
    walk(directory),
  );
const readRepositoryWorkspaces = () =>
  readWorkspaces(repositoryFiles(), (file) =>
    NodeFS.readFileSync(NodePath.join(REPOSITORY_ROOT, file), "utf8"),
  );

describe("selection", () => {
  it("a change in one package selects its tests and its dependents' tests", () => {
    const plan = select(["packages/contracts/src/schema.ts"]);
    assert.deepStrictEqual(directories(plan), ["apps/server", "packages/contracts"]);
    assert.deepStrictEqual(plan.kind === "related" && plan.runs.map((run) => run.files), [
      ["packages/contracts/src/schema.ts"],
      ["packages/contracts/src/schema.ts"],
    ]);
  });

  it("a change outside apps/server runs only the server tests it affects", () => {
    const plan = select(["packages/client-runtime/src/state/threads.ts"]);
    assert.deepStrictEqual(
      plan.kind === "related" && plan.runs.map((run) => [run.directory, run.mode]),
      [
        ["apps/server", "related"],
        ["apps/web", "related"],
        ["packages/client-runtime", "related"],
      ],
    );
  });

  it("follows an undeclared relative import through EXTRA_EDGES", () => {
    const plan = selectLandingTests(
      { changed: ["packages/client-runtime/src/work-log/itemDetail.ts"], deleted: [] },
      readRepositoryWorkspaces(),
    );
    assert.include(directories(plan), "packages/provider-pi");
  });

  it("does not follow a dependency that is only a build input", () => {
    const workspaces = [
      workspace("apps/web", "@t3tools/web"),
      workspace("apps/server", "t3", ["@t3tools/web"]),
    ];
    const plan = selectLandingTests(
      { changed: ["apps/web/src/a.ts"], deleted: [] },
      workspaces,
      [],
    );
    assert.deepStrictEqual(directories(plan), ["apps/web"]);
    assert.deepStrictEqual(BUILD_ONLY_EDGES, [["apps/server", "apps/web"]]);
  });

  it("selects only a changed test file's own workspace", () => {
    const plan = select(["packages/shared/src/git.test.ts"]);
    assert.deepStrictEqual(directories(plan), ["packages/shared"]);
  });

  it("a change in a workspace without tests selects none", () => {
    assert.deepStrictEqual(select(["apps/marketing/src/pages/index.astro"]).kind, "none");
  });

  it("a change to the gate's own tests runs only the scripts workspace", () => {
    const workspaces = readRepositoryWorkspaces();
    const plan = selectLandingTests(
      { changed: ["scripts/test-landing.test.ts"], deleted: [] },
      workspaces,
    );
    assert.deepStrictEqual(plan.kind === "related" && plan.runs.map((run) => run.directory), [
      "scripts",
    ]);
  });

  it("a docs-only change runs no tests", () => {
    const plan = select([
      "docs/operations/development.md",
      "README.md",
      ".github/workflows/ci.yml",
    ]);
    assert.strictEqual(plan.kind, "none");
    assert.deepStrictEqual(landingCommands(plan, FIXTURE, []), []);
  });

  it("the fork upstream receipt is checked by its own gate step, not by tests", () => {
    assert.deepStrictEqual(select(["fork/upstream-receipt.json", "fork/differences.md"]), {
      kind: "none",
      reasons: [],
    });
  });

  it("a docs deletion is harmless but a source deletion is not", () => {
    assert.strictEqual(select([], ["docs/old.md"]).kind, "none");
    assert.strictEqual(select([], ["packages/shared/src/old.ts"]).kind, "complete");
  });
});

describe("tests the import graph cannot see", () => {
  const workspaces = readRepositoryWorkspaces();
  const files = (changed: string) => {
    const plan = selectLandingTests({ changed: [changed], deleted: [] }, workspaces);
    return plan.kind === "related" ? plan.runs.flatMap((run) => run.files) : [];
  };

  it("maps a replay transcript to the modules and tests that read it", () => {
    const selected = files(
      "apps/server/src/orchestration-v2/testkit/fixtures/thread_fork_native/codex_transcript.ndjson",
    );
    assert.include(selected, "apps/server/src/orchestration-v2/testkit/fixtures/index.ts");
    assert.include(
      selected,
      "apps/server/src/orchestration-v2/testkit/ThreadFork.integration.test.ts",
    );
  });

  it("maps a file the tests read from outside the workspace", () => {
    assert.include(files(".github/triage/PLAYBOOK.md"), "apps/server/src/cli/triagePrompt.test.ts");
    assert.include(
      files("native/libghostty-vt/VERSION"),
      "apps/web/src/terminal/ghostty/runtimeAbi.test.ts",
    );
  });

  it("maps source that a test spawns in a child process", () => {
    assert.include(files("packages/shared/src/git.ts"), "apps/server/src/processRunner.test.ts");
    assert.include(
      files("apps/server/scripts/acp-mock-agent.ts"),
      "apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts",
    );
  });

  it("runs a workspace's complete suite when its tests lint in a child process", () => {
    const plan = selectLandingTests(
      { changed: ["oxlint-plugin-t3code/rules/no-test-in-loop.ts"], deleted: [] },
      workspaces,
    );
    assert.deepStrictEqual(
      plan.kind === "related" && plan.runs.map((run) => [run.directory, run.mode]),
      [["oxlint-plugin-t3code", "all"]],
    );
  });

  it("names an existing test or module in every rule and a real workspace for a suite", () => {
    const directoriesWithTests = new Set(
      workspaces.filter((entry) => entry.test).map((entry) => entry.directory),
    );
    for (const rule of INPUT_RULES) {
      for (const file of rule.select ?? [])
        assert.isTrue(
          NodeFS.existsSync(NodePath.join(REPOSITORY_ROOT, file)),
          `${file} (${rule.reason})`,
        );
      for (const directory of rule.workspaces ?? [])
        assert.isTrue(directoriesWithTests.has(directory), directory);
    }
  });

  // A test with one of these patterns reads a file or spawns source by a path the graph never
  // sees. Map it in INPUT_RULES, or list it here with the reason nothing needs mapping.
  const READS_BY_PATH = /new URL\([^)]*import\.meta\.url|import\.meta\.dirname|\b__dirname\b/;
  const REVIEWED_UNMAPPED: Readonly<Record<string, string>> = {
    "apps/desktop/scripts/electron-launcher.test.mjs":
      "passes its own URL to the launcher under test",
    "apps/desktop/src/snapShot/LinuxSnapShot.dbus.test.ts":
      "reads gnome-extension/, mapped by the extension rule",
    "apps/mobile/scripts/network-module.test.ts":
      "reads node_modules, which only a lockfile change moves",
    "apps/mobile/src/lib/uniwind-dev-refresh.test.ts":
      "reads node_modules, which only a lockfile change moves",
    "apps/server/src/provider/acp/AcpSessionRuntime.processTree.test.ts":
      "compiles scripts/acp-thread-spawn-helper.c, mapped by the scripts rule",
    "apps/web/src/components/diffs/codeViewSearch.test.ts":
      "reads node_modules, which only a lockfile change moves",
    "scripts/build-desktop-artifact.test.ts": "checks the repository root for a tarball",
    "scripts/dev-runner.test.ts": "runs the dev runner in a temporary directory",
    "scripts/legend-list-initial-reveal.test.ts":
      "reads node_modules, which only a lockfile change moves",
    "scripts/test-landing.test.ts": "contains the pattern as text",
  };

  it("maps or reviews every test that reads or spawns by path", () => {
    const mapped = new Set(INPUT_RULES.flatMap((rule) => rule.select ?? []));
    const readers = repositoryFiles().filter(
      (file) =>
        /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
        READS_BY_PATH.test(NodeFS.readFileSync(NodePath.join(REPOSITORY_ROOT, file), "utf8")),
    );
    const unmapped = readers.filter((file) => !mapped.has(file) && !(file in REVIEWED_UNMAPPED));
    assert.deepStrictEqual(unmapped, []);
  });

  // Vitest's related-file graph drops an import with a query, so a `?raw` or `?inline` import
  // (whose content the test sees) must map its file to the importer. A `?url` import only
  // resolves the path, which a rename already covers by failing closed.
  it("maps every file imported with ?raw or ?inline to its importer", () => {
    const QUERY_IMPORT = /["'](\.{1,2}\/[^"']+)\?(?:raw|inline)["']/g;
    const unmapped = repositoryFiles()
      .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
      .flatMap((importer) =>
        [
          ...NodeFS.readFileSync(NodePath.join(REPOSITORY_ROOT, importer), "utf8").matchAll(
            QUERY_IMPORT,
          ),
        ].map((match) => ({
          importer,
          imported: NodePath.posix.join(NodePath.posix.dirname(importer), match[1]!),
        })),
      )
      .filter(
        ({ importer, imported }) =>
          !INPUT_RULES.some(
            (rule) => rule.when.test(imported) && (rule.select ?? []).includes(importer),
          ),
      );
    assert.deepStrictEqual(unmapped, []);
  });
});

describe("failing closed", () => {
  it.each([
    ["the lockfile", "pnpm-lock.yaml"],
    ["the workspace file", "pnpm-workspace.yaml"],
    ["a package manifest", "apps/server/package.json"],
    ["the root manifest", "package.json"],
    ["the root Vitest config", "vite.config.ts"],
    ["a workspace Vitest config", "apps/web/vite.config.ts"],
    ["a config import", "scripts/lib/public-config.ts"],
    ["a test setup file", "packages/shared/src/testing/longTempDir.ts"],
    ["a setup file in a workspace", "apps/server/src/testUtils/gitConfig.setup.ts"],
    ["a tsconfig", "packages/shared/tsconfig.json"],
    ["the toolchain pin", ".node-version"],
    ["a dependency patch", "patches/alchemy@2.0.0-beta.80.patch"],
    ["the gate itself", "scripts/test-landing.ts"],
    ["the gate's input rules", "scripts/lib/test-landing-inputs.ts"],
    ["the quarantine", "tests/quarantine.json"],
    ["an unknown path", "tooling/unknown.bin"],
    ["an asset outside any source directory", "apps/server/resources/logo.png"],
  ])("runs the complete suite for %s", (_label, path) => {
    const plan = select([path]);
    assert.strictEqual(plan.kind, "complete");
    assert.isTrue(plan.kind === "complete" && plan.reason.includes(path));
  });

  it("runs the complete suite when a module is deleted", () => {
    const plan = select(["packages/shared/src/kept.ts"], ["packages/shared/src/gone.ts"]);
    assert.strictEqual(plan.kind, "complete");
  });

  it("runs every workspace's test suite with the complete plan", () => {
    const commands = landingCommands({ kind: "complete", reason: "test" }, FIXTURE, []);
    assert.deepStrictEqual(
      commands.map((command) => command.cwd),
      [
        "packages/shared",
        "packages/contracts",
        "packages/client-runtime",
        "apps/server",
        "apps/web",
      ],
    );
    assert.deepStrictEqual(request(commands[4]!).flags, [
      "--passWithNoTests",
      "--project",
      "unit",
      "--project",
      "browser",
    ]);
    assert.isUndefined(request(commands[4]!).files);
  });

  it("runs a workspace whose test script it cannot read in full", () => {
    const opaque = [workspace("packages/odd", "odd", [], "opaque")];
    const plan = selectLandingTests(
      { changed: ["packages/odd/src/a.ts"], deleted: [] },
      opaque,
      [],
    );
    assert.deepStrictEqual(plan.kind === "related" && plan.runs.map((run) => run.mode), ["all"]);
    assert.deepStrictEqual(landingCommands(plan, opaque, [])[0]?.command, ["pnpm", "run", "test"]);
  });

  it("only version fields are no test input", () => {
    const before = JSON.stringify({
      name: "t3",
      version: "1.0.0",
      scripts: { test: "vp test run" },
    });
    assert.isTrue(versionOnlyChange(before, before.replace("1.0.0", "1.0.1")));
    assert.isFalse(versionOnlyChange(before, before.replace("vp test run", "vp test run --bail")));
    assert.isFalse(versionOnlyChange(before, "not json"));
  });
});

// A fake JJ repository: commits hold their files, `@` names one of them.
const ID = (letter: string) => letter.repeat(40);

interface FakeCommit {
  readonly parent?: string;
  readonly conflict?: boolean;
  readonly empty?: boolean;
  readonly files: Record<string, string>;
}

function fakeJj(commits: Record<string, FakeCommit>, working: string, integration: string) {
  const resolve = (revision: string) =>
    revision === "@" ? working : revision === "t3peach" ? integration : revision;
  const calls: string[][] = [];
  const query: JjQuery = (args) => {
    calls.push([...args]);
    const at = (flag: string) => args[args.indexOf(flag) + 1]!;
    if (args[0] === "log") {
      const id = resolve(at("-r"));
      const commit = commits[id];
      if (!commit) throw new Error(`unknown revision ${id}`);
      const template = at("-T");
      return template === "commit_id"
        ? id
        : `${id}\n${commit.parent ?? ""}\n${commit.conflict ?? false}\n${commit.empty ?? false}`;
    }
    if (args[0] === "file" && args[1] === "list")
      return `${Object.keys(commits[resolve(at("-r"))]!.files).join("\n")}\n`;
    if (args[0] === "file" && args[1] === "show")
      return commits[resolve(at("-r"))]!.files[args.at(-1)!]!;
    if (args[0] === "diff") {
      const from = commits[resolve(at("--from"))]!.files;
      const to = commits[resolve(at("--to"))]!.files;
      return [...new Set([...Object.keys(from), ...Object.keys(to)])]
        .filter((file) => from[file] !== to[file])
        .map((file) => `${JSON.stringify(file)}\n`)
        .join("");
    }
    throw new Error(`unexpected jj ${args.join(" ")}`);
  };
  return { query, calls };
}

const MANIFEST = (name: string, extra: object = {}) =>
  JSON.stringify({ name, version: "1.0.0", scripts: { test: "vp test run" }, ...extra });

const BASE_FILES = {
  "apps/server/package.json": MANIFEST("t3"),
  "apps/server/src/a.ts": "a",
  "package.json": JSON.stringify({ name: "root", version: "1.0.0" }),
  "docs/a.md": "docs",
};

describe("the exact candidate", () => {
  it("selects from the candidate's diff against its single integration parent", () => {
    const { query } = fakeJj(
      {
        [ID("1")]: { files: BASE_FILES },
        [ID("2")]: { parent: ID("1"), files: { ...BASE_FILES, "apps/server/src/a.ts": "changed" } },
      },
      ID("2"),
      ID("1"),
    );
    const { snapshot, plan } = planCandidate(() => candidateChanges(query, "t3peach"), []);
    assert.deepStrictEqual(snapshot?.changed, ["apps/server/src/a.ts"]);
    assert.deepStrictEqual(directories(plan), ["apps/server"]);
  });

  it("follows an empty continuation child to the candidate it continues", () => {
    const { query } = fakeJj(
      {
        [ID("1")]: { files: BASE_FILES },
        [ID("2")]: { parent: ID("1"), files: { ...BASE_FILES, "docs/a.md": "edited" } },
        [ID("3")]: {
          parent: ID("2"),
          empty: true,
          files: { ...BASE_FILES, "docs/a.md": "edited" },
        },
      },
      ID("3"),
      ID("1"),
    );
    const snapshot = candidateChanges(query, "t3peach");
    assert.strictEqual(snapshot.candidate, ID("2"));
    assert.deepStrictEqual(snapshot.changed, ["docs/a.md"]);
  });

  it("treats a version-only package.json change as no test input", () => {
    const { query } = fakeJj(
      {
        [ID("1")]: { files: BASE_FILES },
        [ID("2")]: {
          parent: ID("1"),
          files: {
            ...BASE_FILES,
            "apps/server/package.json": MANIFEST("t3").replace("1.0.0", "1.0.1"),
          },
        },
      },
      ID("2"),
      ID("1"),
    );
    assert.deepStrictEqual(planCandidate(() => candidateChanges(query, "t3peach"), []).plan, {
      kind: "none",
      reasons: [],
    });
  });

  it.each([
    [
      "a candidate not rebased onto the integration parent",
      {
        [ID("1")]: { files: BASE_FILES },
        [ID("9")]: { files: BASE_FILES },
        [ID("2")]: { parent: ID("9"), files: BASE_FILES },
      },
    ],
    [
      "a conflicted candidate",
      {
        [ID("1")]: { files: BASE_FILES },
        [ID("2")]: { parent: ID("1"), conflict: true, files: BASE_FILES },
      },
    ],
    [
      "a merge candidate",
      {
        [ID("1")]: { files: BASE_FILES },
        [ID("2")]: { parent: `${ID("1")} ${ID("9")}`, files: BASE_FILES },
      },
    ],
  ])("runs the complete suite for %s", (_label, commits) => {
    const { query } = fakeJj(commits, ID("2"), ID("1"));
    const plan = planCandidate(() => candidateChanges(query, "t3peach"), []).plan;
    assert.strictEqual(plan.kind, "complete");
    assert.isTrue(
      plan.kind === "complete" && plan.reason.startsWith("candidate unreadable or ambiguous"),
    );
  });

  it("runs the complete suite when JJ cannot be read", () => {
    const plan = planCandidate(() => {
      throw new Error("jj is unavailable");
    }).plan;
    assert.strictEqual(plan.kind, "complete");
  });

  it("refuses a candidate that moved while the tests ran", () => {
    const state = {
      [ID("1")]: { files: BASE_FILES },
      [ID("2")]: { parent: ID("1"), files: { ...BASE_FILES, "apps/server/src/a.ts": "changed" } },
      [ID("3")]: { parent: ID("1"), files: { ...BASE_FILES, "apps/server/src/a.ts": "amended" } },
    };
    let working = ID("2");
    const { query: inner } = fakeJj(state, ID("2"), ID("1"));
    const moving: JjQuery = (args) =>
      args[0] === "log" && args.includes("@")
        ? fakeJj(state, working, ID("1")).query(args)
        : inner(args);
    const snapshot = candidateChanges(moving, "t3peach");
    working = ID("3");
    assert.throws(() => snapshot.assertUnchanged(), /changed during verification/);
  });

  it("compares two commits without the integration bookmark", () => {
    const { query } = fakeJj(
      {
        [ID("1")]: { files: BASE_FILES },
        [ID("2")]: { parent: ID("1"), files: { ...BASE_FILES, "apps/server/src/b.ts": "new" } },
      },
      ID("2"),
      ID("1"),
    );
    assert.deepStrictEqual(changesBetween(query, ID("1"), ID("2")).changed, [
      "apps/server/src/b.ts",
    ]);
  });
});

describe("the budget", () => {
  const test = (file: string, directory = "apps/server") => ({ directory, file });
  const budgetSeconds = LANDING_BUDGET.startupSeconds + 10;

  it("estimates each workspace as one run spread across the workers", () => {
    const durations = { "apps/server/a.test.ts": 40, "apps/server/b.test.ts": 8 };
    // The largest file bounds a run whose sum spreads thinner than it.
    assert.strictEqual(
      estimateSeconds([test("apps/server/a.test.ts"), test("apps/server/b.test.ts")], durations),
      LANDING_BUDGET.startupSeconds + 40,
    );
    const many = Array.from({ length: 16 }, (_, index) => test(`apps/server/${index}.test.ts`));
    assert.strictEqual(
      estimateSeconds(many, Object.fromEntries(many.map(({ file }) => [file, 10]))),
      LANDING_BUDGET.startupSeconds + (16 * 10) / LANDING_BUDGET.workers,
    );
    assert.strictEqual(
      estimateSeconds(
        [test("apps/server/a.test.ts"), test("packages/shared/a.test.ts", "packages/shared")],
        durations,
      ),
      2 * LANDING_BUDGET.startupSeconds + 40 + 2,
    );
  });

  it("always runs a changed test, whatever it costs", () => {
    const budget = budgetLandingTests(
      [test("apps/server/src/slow.test.ts"), test("apps/server/src/other.test.ts")],
      ["apps/server/src/slow.test.ts"],
      { "apps/server/src/slow.test.ts": 500, "apps/server/src/other.test.ts": 1 },
      budgetSeconds,
    );
    assert.deepStrictEqual(
      budget.selected.map(({ file }) => file),
      ["apps/server/src/slow.test.ts"],
    );
    assert.deepStrictEqual(
      budget.deferred.map(({ file }) => file),
      ["apps/server/src/other.test.ts"],
    );
  });

  it("fills the budget nearest the change first, cheapest first within a rank", () => {
    const durations = {
      "apps/server/src/git/GitManager.test.ts": 6,
      "apps/server/src/git/Other.test.ts": 3,
      "apps/server/src/git/Cheap.test.ts": 1,
      // Alone, either would outrun the budget.
      "apps/server/src/far/Cheap.test.ts": 11,
      "apps/server/src/far/Dear.test.ts": 12,
    };
    const budget = budgetLandingTests(
      Object.keys(durations).map((file) => test(file)),
      ["apps/server/src/git/GitManager.ts"],
      durations,
      budgetSeconds,
    );
    assert.deepStrictEqual(
      budget.selected.map(({ file }) => file),
      [
        "apps/server/src/git/GitManager.test.ts",
        "apps/server/src/git/Cheap.test.ts",
        "apps/server/src/git/Other.test.ts",
      ],
    );
    assert.deepStrictEqual(
      budget.deferred.map(({ file }) => file),
      ["apps/server/src/far/Cheap.test.ts", "apps/server/src/far/Dear.test.ts"],
    );
    assert.isAtMost(budget.seconds, budgetSeconds);
  });

  it("spreads a report's unattributed worker time evenly across its files", () => {
    const durations = durationsFromReports(
      [
        {
          cwd: "apps/server",
          seconds: LANDING_BUDGET.startupSeconds + 10,
          testResults: [
            { name: "/repo/apps/server/src/a.test.ts", startTime: 0, endTime: 2000 },
            { name: "/repo/apps/server/src/b.test.ts", startTime: 0, endTime: 10_000 },
          ],
        },
      ],
      "/repo",
    );
    // Two workers busy for the 10s past startup is 20s, 8s of it outside any file: 4s each.
    assert.deepStrictEqual(durations, {
      "apps/server/src/a.test.ts": 6,
      "apps/server/src/b.test.ts": 14,
    });
  });

  it("runs the budgeted files by path, in parallel, and an opaque workspace whole", async () => {
    const workspaces = [
      ...FIXTURE,
      workspace("packages/odd", "@t3tools/odd", ["@t3tools/shared"], "opaque"),
    ];
    const listed: Record<string, ReadonlyArray<string>> = {
      "packages/shared": ["packages/shared/src/a.test.ts", "packages/shared/src/flaky.test.ts"],
      "apps/server": ["apps/server/src/s.test.ts"],
      "packages/client-runtime": [],
      "apps/web": [],
    };
    const plan = selectLandingTests(
      { changed: ["packages/shared/src/a.ts"], deleted: [] },
      workspaces,
      [],
    );
    const budget = await budgetedRuns(
      plan,
      workspaces,
      { changed: ["packages/shared/src/a.ts"], deleted: [] },
      {},
      [{ file: "packages/shared/src/flaky.test.ts", issue: 1, reason: "flaky" }],
      { list: async ({ directory }) => listed[directory] ?? [] },
    );
    assert.deepStrictEqual(budget.runs, [
      { directory: "apps/server", tests: ["apps/server/src/s.test.ts"] },
      { directory: "packages/odd" },
      { directory: "packages/shared", tests: ["packages/shared/src/a.test.ts"] },
    ]);
    const commands = runCommands(budget.runs, workspaces, []);
    const shared = request(commands.find((command) => command.cwd === "packages/shared")!);
    assert.strictEqual(shared.workers, LANDING_BUDGET.workers);
    assert.deepStrictEqual(shared.files, ["packages/shared/src/a.test.ts"]);
    assert.deepStrictEqual(commands.find((command) => command.cwd === "packages/odd")!.command, [
      "pnpm",
      "run",
      "test",
    ]);
  });
});

describe("what the budget never defers", () => {
  const test = (file: string, directory = "apps/server") => ({ directory, file });
  const GUARD = "scripts/test-landing.test.ts";

  it("reads the relative modules a test imports or mocks, not packages", () => {
    assert.deepStrictEqual(
      relativeImports(
        "apps/server/src/orchestration-v2/ThreadWatch.test.ts",
        [
          'import * as HqAgentConnections from "../hq/HqAgentConnections.ts";',
          'import { Effect } from "effect";',
          'vi.mock("./ThreadWatch.testkit.ts?worker");',
          'const later = await import("../hq/Other.js");',
        ].join("\n"),
      ),
      [
        "apps/server/src/hq/HqAgentConnections",
        "apps/server/src/orchestration-v2/ThreadWatch.testkit",
        "apps/server/src/hq/Other",
      ],
    );
  });

  it("keeps a direct importer of a changed module when the optional budget is full", () => {
    // 9268dfbc changed HqAgentConnections.ts; ThreadWatch.test.ts imports it from another directory.
    const importer = "apps/server/src/orchestration-v2/ThreadWatch.test.ts";
    const candidates = [
      test(importer),
      test("apps/server/src/hq/Beside.test.ts"),
      test("apps/server/src/far/Far.test.ts"),
    ];
    const durations = {
      [importer]: 8,
      "apps/server/src/hq/Beside.test.ts": 9,
      "apps/server/src/far/Far.test.ts": 9,
    };
    const imports = (file: string) =>
      file === importer ? ["apps/server/src/hq/HqAgentConnections"] : [];
    const budget = budgetLandingTests(
      candidates,
      ["apps/server/src/hq/HqAgentConnections.ts"],
      durations,
      LANDING_BUDGET.startupSeconds + 8,
      { imports },
    );
    assert.deepStrictEqual(
      budget.selected.map(({ file }) => file),
      [importer],
    );
    assert.deepStrictEqual(
      budget.deferred.map(({ file }) => file),
      ["apps/server/src/hq/Beside.test.ts", "apps/server/src/far/Far.test.ts"],
    );
    assert.isFalse(budget.overBudget);
    // Without the import it ranks last by cost and the budget defers it, as 9268dfbc did.
    assert.include(
      budgetLandingTests(
        candidates,
        ["apps/server/src/hq/HqAgentConnections.ts"],
        durations,
        12,
      ).deferred.map(({ file }) => file),
      importer,
    );
  });

  it("reports mandatory work over the budget and still bounds the optional tests", () => {
    const budget = budgetLandingTests(
      [
        test("apps/server/src/a.test.ts"),
        test("apps/server/src/b.test.ts"),
        test("apps/server/src/c.test.ts"),
      ],
      ["apps/server/src/m.ts"],
      { "apps/server/src/a.test.ts": 200, "apps/server/src/b.test.ts": 1 },
      LANDING_BUDGET.startupSeconds + 10,
      { imports: (file) => (file.endsWith("a.test.ts") ? ["apps/server/src/m"] : []) },
    );
    assert.deepStrictEqual(
      budget.selected.map(({ file }) => file),
      ["apps/server/src/a.test.ts"],
    );
    assert.strictEqual(budget.mandatory, 1);
    assert.isTrue(budget.overBudget);
    assert.include(budgetSummary(budget), "Over budget");
  });

  it("runs the invariant guard when a test is added, removed or renamed", () => {
    assert.deepStrictEqual(invariantGuards({ changed: ["apps/server/src/x.ts"], deleted: [] }), []);
    assert.deepStrictEqual(
      invariantGuards({ changed: ["apps/server/src/x.test.ts"], deleted: [] }),
      [],
    );
    for (const change of [
      {
        changed: ["apps/mobile/scripts/new.test.ts"],
        added: ["apps/mobile/scripts/new.test.ts"],
        deleted: [],
      },
      {
        changed: ["apps/server/src/outboundHttp.test.ts"],
        deleted: ["apps/server/src/outboundHttp.test.ts"],
      },
    ])
      assert.deepStrictEqual(invariantGuards(change), INVARIANT_GUARDS);
    assert.deepStrictEqual(INVARIANT_GUARDS, [GUARD]);
  });

  it("selects the guard for an added test and keeps it through the budget", () => {
    const workspaces = readRepositoryWorkspaces();
    const added = "apps/mobile/scripts/new-reader.test.ts";
    const plan = selectLandingTests({ changed: [added], added: [added], deleted: [] }, workspaces);
    assert.isTrue(plan.kind === "related" && plan.runs.some((run) => run.files.includes(GUARD)));
    const change = { changed: [added], added: [added], deleted: [] };
    const budget = budgetLandingTests(
      [test(added, "apps/mobile"), test(GUARD, "scripts")],
      [added],
      { [GUARD]: 500 },
      LANDING_BUDGET.seconds,
      { guards: invariantGuards(change) },
    );
    assert.deepStrictEqual(budget.deferred, []);
  });

  it("keeps the guard when a test named by INPUT_RULES is deleted, through selection and budgeting", async () => {
    const workspaces = readRepositoryWorkspaces();
    const deleted = "apps/server/src/outboundHttp.test.ts"; // named by SOURCE_SPAWNERS
    const change = { changed: [deleted], deleted: [deleted] };
    const plan = selectLandingTests(change, workspaces);
    assert.strictEqual(plan.kind, "complete");
    const many = Array.from({ length: 100 }, (_, index) => `apps/server/src/t${index}.test.ts`);
    const durations = Object.fromEntries([...many.map((file) => [file, 5]), [GUARD, 50]]);
    const run = (guarded: boolean) =>
      budgetedRuns(
        plan,
        workspaces,
        guarded ? change : { changed: [], deleted: [] },
        durations,
        [],
        {
          list: async ({ directory }) =>
            directory === "scripts" ? [GUARD] : directory === "apps/server" ? many : [],
        },
      );
    assert.deepStrictEqual(
      (await run(true)).runs.find((entry) => entry.directory === "scripts"),
      {
        directory: "scripts",
        tests: [GUARD],
      },
    );
    // The control: priced like any far test, the guard is what the budget used to defer.
    assert.include(
      (await run(false)).deferred.map(({ file }) => file),
      GUARD,
    );
  });

  it("retains the summary and every deferred file in reports that outlive clipped output", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-landing-deferred-"));
    try {
      const deferred = Array.from({ length: 300 }, (_, index) =>
        test(`apps/server/src/d${index}.test.ts`),
      );
      const budget = {
        selected: [test("apps/server/src/s.test.ts")],
        mandatory: 1,
        overBudget: true,
        seconds: 70,
      };
      const reports = writeBudgetReports(
        directory,
        { ...budget, deferred },
        {
          "apps/server/src/d1.test.ts": 4,
        },
      );
      assert.deepStrictEqual(
        reports.map(({ path }) => path),
        ["landing-budget.json", "landing-deferred.json"],
      );
      const rows = (path: string) =>
        (
          JSON.parse(NodeFS.readFileSync(NodePath.join(directory, path), "utf8")) as {
            testResults: ReadonlyArray<{
              name: string;
              status: string;
              startTime: number;
              endTime: number;
            }>;
          }
        ).testResults;
      const deferredRows = rows("landing-deferred.json");
      assert.deepStrictEqual(
        deferredRows.map((row) => row.name),
        deferred.map(({ file }) => file),
      );
      assert.strictEqual(deferredRows[1]!.endTime - deferredRows[1]!.startTime, 4000);
      assert.isTrue(
        [...deferredRows, ...rows("landing-budget.json")].every((row) => row.status === "skipped"),
      );
      // The summary, over-budget notice included, is the suite name the runner keeps with the row.
      assert.strictEqual(reports[0]!.suite, budgetSummary({ ...budget, deferred }));
      assert.include(reports[0]!.suite, "Over budget");
      // With nothing deferred only the summary remains; an unwritable directory yields no report.
      assert.deepStrictEqual(
        writeBudgetReports(directory, { ...budget, overBudget: false, deferred: [] }, {}).map(
          ({ path }) => path,
        ),
        ["landing-budget.json"],
      );
      assert.deepStrictEqual(
        writeBudgetReports(NodePath.join(directory, "missing"), { ...budget, deferred }, {}),
        [],
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("an empty whole suite", () => {
  it("still runs, so a configuration that matches no tests fails the gate", async () => {
    const budget = await budgetedRuns(
      { kind: "complete", reason: "test" },
      [workspace("packages/shared", "@t3tools/shared")],
      { changed: [], deleted: [] },
      {},
      [],
      { list: async () => [] },
    );
    assert.deepStrictEqual(budget.runs, [{ directory: "packages/shared" }]);
  });
});

describe("the Vitest runner", () => {
  it("runs exactly the requested files, not a sibling its path prefixes, and fails with them or their teardown", () => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-landing-run-")),
    );
    try {
      NodeFS.symlinkSync(
        NodePath.join(REPOSITORY_ROOT, "node_modules"),
        NodePath.join(root, "node_modules"),
        "dir",
      );
      NodeFS.mkdirSync(NodePath.join(root, "pkg/src"), { recursive: true });
      const body =
        'import { expect, it } from "vite-plus/test";\nit("runs", () => expect(1).toBe(1));\n';
      for (const file of ["a.test.ts", "a.test.tsx", "b.test.ts", "flaky.test.ts"]) {
        NodeFS.writeFileSync(NodePath.join(root, "pkg/src", file), body);
      }
      const reportFile = NodePath.join(root, "report.json");
      const [executable, ...args] = runCommand({
        root,
        directory: "pkg",
        flags: [],
        files: ["pkg/src/a.test.ts", "pkg/src/flaky.test.ts"],
        exclude: ["pkg/src/flaky.test.ts"],
        workers: 2,
        reportFile,
      });
      const result = NodeChildProcess.spawnSync(executable!, args, {
        cwd: NodePath.join(root, "pkg"),
        encoding: "utf8",
      });
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      const report = JSON.parse(NodeFS.readFileSync(reportFile, "utf8")) as {
        testResults: ReadonlyArray<{ name: string }>;
      };
      assert.deepStrictEqual(
        report.testResults.map((file) => NodePath.relative(root, file.name)),
        ["pkg/src/a.test.ts"],
      );
      NodeFS.writeFileSync(
        NodePath.join(root, "pkg/src/b.test.ts"),
        body.replace("toBe(1)", "toBe(2)"),
      );
      const [failExecutable, ...failArgs] = runCommand({
        root,
        directory: "pkg",
        flags: [],
        files: ["pkg/src/b.test.ts"],
        workers: 2,
      });
      assert.strictEqual(
        NodeChildProcess.spawnSync(failExecutable!, failArgs, { cwd: NodePath.join(root, "pkg") })
          .status,
        1,
      );
      // A global teardown that throws fails the run though every test passed.
      NodeFS.writeFileSync(
        NodePath.join(root, "pkg/teardown.ts"),
        'export default () => () => {\n  throw new Error("teardown");\n};\n',
      );
      NodeFS.writeFileSync(
        NodePath.join(root, "pkg/vitest.config.ts"),
        'export default { test: { globalSetup: ["./teardown.ts"] } };\n',
      );
      const [teardownExecutable, ...teardownArgs] = runCommand({
        root,
        directory: "pkg",
        flags: ["--config", "vitest.config.ts"],
        files: ["pkg/src/a.test.ts"],
        workers: 2,
      });
      assert.strictEqual(
        NodeChildProcess.spawnSync(teardownExecutable!, teardownArgs, {
          cwd: NodePath.join(root, "pkg"),
        }).status,
        1,
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("quarantine", () => {
  const entry = {
    file: "apps/server/src/flaky.test.ts",
    issue: 123,
    reason: "times out under load",
  };

  it("leaves a quarantined test out of every selected and complete run, per workspace", () => {
    const related = select(["packages/shared/src/a.ts"]);
    const commands = landingCommands(related, FIXTURE, [
      entry,
      { ...entry, file: "packages/shared/src/odd.test.ts" },
    ]);
    const excluded = (cwd: string) =>
      request(commands.find((command) => command.cwd === cwd)!).exclude;
    assert.deepStrictEqual(excluded("apps/server"), ["apps/server/src/flaky.test.ts"]);
    assert.deepStrictEqual(excluded("packages/shared"), ["packages/shared/src/odd.test.ts"]);
    const all = landingCommands({ kind: "complete", reason: "test" }, FIXTURE, [entry]);
    assert.deepStrictEqual(request(all.find((command) => command.cwd === "apps/server")!).exclude, [
      "apps/server/src/flaky.test.ts",
    ]);
  });

  it("reads the repository's quarantine", () => {
    readQuarantine(
      NodeFS.readFileSync(NodePath.join(REPOSITORY_ROOT, "tests/quarantine.json"), "utf8"),
    );
  });

  it("requires an Issue number and a reason for each test", () => {
    assert.deepStrictEqual(readQuarantine(JSON.stringify([entry])), [entry]);
    for (const invalid of [
      { ...entry, issue: 0 },
      { ...entry, issue: "123" },
      { ...entry, reason: " " },
      { ...entry, file: "../x.test.ts" },
      { ...entry, file: "apps/server/src/flaky.ts" },
      { file: entry.file },
    ]) {
      assert.throws(
        () => readQuarantine(JSON.stringify([invalid])),
        /Invalid tests\/quarantine\.json/,
      );
    }
    assert.throws(() => readQuarantine("{}"), /Invalid tests\/quarantine\.json/);
  });
});

describe("audit", () => {
  it("runs every workspace's complete suite, which only the gate narrows by quarantine", () => {
    const entry = { file: "apps/server/src/flaky.test.ts", issue: 1, reason: "flaky" };
    const complete = { kind: "complete", reason: "audit" } as const;
    const audit = landingCommands(complete, FIXTURE, []);
    assert.deepStrictEqual(audit.map((command) => command.cwd).toSorted(), [
      "apps/server",
      "apps/web",
      "packages/client-runtime",
      "packages/contracts",
      "packages/shared",
    ]);
    assert.isFalse(audit.some((command) => request(command).exclude));
    assert.isTrue(
      landingCommands(complete, FIXTURE, [entry]).some((command) => request(command).exclude),
    );
  });

  it("--audit --plan selects the complete suite without reading a candidate", () => {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(REPOSITORY_ROOT, "scripts/test-landing.ts"), "--audit", "--plan"],
      { cwd: NodeOS.tmpdir(), encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } },
    );
    assert.strictEqual(result.status, 0, result.stderr);
    assert.include(result.stdout, '"kind": "complete"');
    assert.include(result.stdout, "Landing quarantine exclusions: []");
    assert.match(result.stdout, /\(cd apps\/server && node \S+test-landing-vitest\.ts run /);
    assert.match(result.stdout, /\(cd packages\/shared && node \S+test-landing-vitest\.ts run /);
  });

  it("is the test:audit package script", () => {
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(REPOSITORY_ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    assert.strictEqual(manifest.scripts["test:audit"], "node scripts/test-landing.ts --audit");
  });
});

describe("test reports", () => {
  const plan = select(["packages/shared/src/a.ts"]);

  it("writes a Vitest JSON report per run, next to the console reporter, under the report directory", () => {
    const commands = landingCommands(plan, FIXTURE, [], "/reports");
    const shared = commands.find((command) => command.cwd === "packages/shared")!;
    assert.deepStrictEqual(shared.report, {
      format: "vitest-json",
      path: "vitest-packages-shared.json",
      suite: "@t3tools/shared",
      cwd: "packages/shared",
    });
    assert.strictEqual(request(shared).reportFile, "/reports/vitest-packages-shared.json");
  });

  it("adds no reporter or report without a report directory", () => {
    for (const command of landingCommands(plan, FIXTURE, [])) {
      assert.isUndefined(command.report);
      assert.isUndefined(request(command).reportFile);
    }
  });

  it("lists every expected report up front and never throws", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-landing-reports-"));
    try {
      const present = {
        format: "vitest-json" as const,
        path: "vitest-a.json",
        suite: "a",
        cwd: "packages/a",
      };
      const missing = { ...present, path: "vitest-b.json", suite: "b", cwd: "packages/b" };
      NodeFS.writeFileSync(NodePath.join(directory, present.path), "{}");
      writeManifest(directory, [present, missing]);
      assert.deepStrictEqual(
        JSON.parse(
          NodeFS.readFileSync(NodePath.join(directory, "slipjay-test-reports.json"), "utf8"),
        ),
        { version: 1, reports: [present, missing] },
      );
      assert.isFalse(writeManifest(NodePath.join(directory, "does", "not", "exist"), [present]));
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the dependency edges the selection relies on", () => {
  const workspaces = readRepositoryWorkspaces();
  const owner = (file: string) =>
    workspaces
      .filter((entry) => file.startsWith(`${entry.directory}/`))
      .toSorted((a, b) => b.directory.length - a.directory.length)[0];
  const imports = (text: string) =>
    [...text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)].map(
      (match) => match[1]!,
    );

  it("matches every pnpm workspace pattern and parses every test script", () => {
    const lines = NodeFS.readFileSync(
      NodePath.join(REPOSITORY_ROOT, "pnpm-workspace.yaml"),
      "utf8",
    ).split("\n");
    const patterns = lines.slice(1, lines.indexOf("")).map((line) => line.replace(/^\s*-\s*/, ""));
    const directories = workspaces.map((entry) => entry.directory);
    for (const pattern of patterns) {
      const covered = pattern.endsWith("/*")
        ? directories.some((directory) => directory.startsWith(pattern.slice(0, -1)))
        : directories.includes(pattern);
      assert.isTrue(covered, `${pattern} has no workspace the gate knows`);
    }
    assert.isTrue(
      workspaces.every((entry) => entry.test !== "opaque"),
      "every test script is `vp test run` with flags the gate's runner reproduces",
    );
  });

  it("declares every package import and relative cross-workspace import of test and source files", () => {
    const undeclared: string[] = [];
    for (const file of repositoryFiles()) {
      const from = owner(file);
      if (
        !from ||
        !/\.[cm]?[jt]sx?$/.test(file) ||
        /(?:^|\/)vite[^/]*\.config\.[cm]?[jt]s$/.test(file)
      )
        continue;
      const declared = new Set(from.dependencies);
      for (const specifier of imports(
        NodeFS.readFileSync(NodePath.join(REPOSITORY_ROOT, file), "utf8"),
      )) {
        // Manifests are global inputs (a version-only change is no test input).
        if (specifier.endsWith("package.json")) continue;
        if (specifier.startsWith(".")) {
          const target = NodePath.posix.normalize(
            NodePath.posix.join(NodePath.posix.dirname(file), specifier),
          );
          const to = owner(`${target}/`);
          // A data file another workspace imports can be mapped by an input rule instead.
          if (specifier.endsWith(".json") && INPUT_RULES.some((rule) => rule.when.test(target)))
            continue;
          if (
            to &&
            to.directory !== from.directory &&
            !declared.has(to.name) &&
            !EXTRA_EDGES.some(([a, b]) => a === from.directory && b === to.directory)
          ) {
            undeclared.push(`${file} imports ${to.directory} by relative path`);
          }
        } else {
          const to = workspaces.find(
            (entry) => specifier === entry.name || specifier.startsWith(`${entry.name}/`),
          );
          if (
            to &&
            to.directory !== from.directory &&
            !declared.has(to.name) &&
            !EXTRA_EDGES.some(([a, b]) => a === from.directory && b === to.directory)
          ) {
            undeclared.push(`${file} imports ${to.name} without declaring it`);
          }
        }
      }
    }
    assert.deepStrictEqual(
      undeclared,
      [],
      "declare the dependency in package.json or add the pair to EXTRA_EDGES",
    );
  });

  it("never imports across a build-only edge", () => {
    const imported: string[] = [];
    for (const [from, to] of BUILD_ONLY_EDGES) {
      const target = workspaces.find((entry) => entry.directory === to)!;
      for (const file of repositoryFiles().filter((candidate) =>
        candidate.startsWith(`${from}/`),
      )) {
        if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
        for (const specifier of imports(
          NodeFS.readFileSync(NodePath.join(REPOSITORY_ROOT, file), "utf8"),
        )) {
          const resolved = specifier.startsWith(".")
            ? NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(file), specifier))
            : specifier;
          if (
            specifier === target.name ||
            specifier.startsWith(`${target.name}/`) ||
            resolved.startsWith(`${to}/`)
          ) {
            imported.push(`${file} imports ${specifier}`);
          }
        }
      }
    }
    assert.deepStrictEqual(imported, [], "move the pair out of BUILD_ONLY_EDGES");
  });

  it("treats everything a Vitest config imports as a complete-suite change", () => {
    const configs = repositoryFiles().filter((file) =>
      /(?:^|\/)vite[^/]*\.config\.[cm]?[jt]s$/.test(file),
    );
    assert.isAbove(configs.length, 0);
    const uncovered: string[] = [];
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = NodeFS.readFileSync(NodePath.join(REPOSITORY_ROOT, file), "utf8");
      for (const specifier of imports(text)) {
        if (!specifier.startsWith(".")) {
          const shared = /^@t3tools\/shared\/(.+)$/.exec(specifier);
          if (shared) uncovered.push(`packages/shared/src/${shared[1]}.ts`);
          continue;
        }
        const base = NodePath.posix.normalize(
          NodePath.posix.join(NodePath.posix.dirname(file), specifier),
        );
        const resolved = [base, `${base}.ts`, `${base}.mjs`, `${base}/index.ts`].find(
          (candidate) =>
            NodeFS.existsSync(NodePath.join(REPOSITORY_ROOT, candidate)) &&
            NodeFS.statSync(NodePath.join(REPOSITORY_ROOT, candidate)).isFile(),
        );
        if (resolved && !resolved.endsWith(".json")) {
          uncovered.push(resolved);
          if (/\.[cm]?[jt]s$/.test(resolved)) visit(resolved);
        }
      }
    };
    for (const config of configs) visit(config);
    const changed = [...new Set(uncovered)].filter(
      (file) =>
        selectLandingTests({ changed: [file], deleted: [] }, workspaces).kind !== "complete",
    );
    assert.deepStrictEqual(changed, [], "add it to GLOBAL in scripts/test-landing.ts");
  });
});
