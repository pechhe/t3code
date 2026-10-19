// @effect-diagnostics nodeBuiltinImport:off - Reads the repository's tracked files and writes report fixtures to a temporary directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  candidateChanges,
  changesBetween,
  landingCommands,
  planCandidate,
  readQuarantine,
  readWorkspaces,
  selectLandingTests,
  versionOnlyChange,
  writeManifest,
  type JjQuery,
  type LandingWorkspace,
} from "./test-landing.ts";
import { BUILD_ONLY_EDGES, EXTRA_EDGES, INPUT_RULES } from "./lib/test-landing-inputs.ts";

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

  it("a change outside apps/server runs the tests it affects and not the server's", () => {
    const plan = select(["packages/client-runtime/src/state/threads.ts"]);
    assert.deepStrictEqual(directories(plan), ["apps/web", "packages/client-runtime"]);
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
    assert.include(
      files("packages/shared/src/git.ts"),
      "apps/server/src/claudeHistoryWorker.test.ts",
    );
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
    assert.deepStrictEqual(commands[4]?.command.slice(0, 5), ["pnpm", "exec", "vp", "test", "run"]);
    assert.include(commands[4]?.command ?? [], "browser");
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
    const server = commands.find((command) => command.cwd === "apps/server")!;
    assert.deepStrictEqual(
      server.command.slice(
        server.command.indexOf("--exclude"),
        server.command.indexOf("--exclude") + 2,
      ),
      ["--exclude", "src/flaky.test.ts"],
    );
    const shared = commands.find((command) => command.cwd === "packages/shared")!;
    assert.include(shared.command, "src/odd.test.ts");
    assert.notInclude(shared.command, "src/flaky.test.ts");
    const all = landingCommands({ kind: "complete", reason: "test" }, FIXTURE, [entry]);
    assert.include(
      all.find((command) => command.cwd === "apps/server")!.command,
      "src/flaky.test.ts",
    );
  });

  it("is empty for now", () => {
    assert.deepStrictEqual(
      readQuarantine(
        NodeFS.readFileSync(NodePath.join(REPOSITORY_ROOT, "tests/quarantine.json"), "utf8"),
      ),
      [],
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
    assert.isFalse(audit.some((command) => command.command.includes("--exclude")));
    assert.isTrue(
      landingCommands(complete, FIXTURE, [entry]).some((command) =>
        command.command.includes("--exclude"),
      ),
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
    assert.include(result.stdout, "(cd apps/server && pnpm exec vp test run");
    assert.include(result.stdout, "(cd packages/shared && pnpm exec vp test run");
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
    assert.include(shared.command, "--reporter=default");
    assert.include(shared.command, "--reporter=json");
    assert.include(shared.command, "--outputFile.json=/reports/vitest-packages-shared.json");
  });

  it("adds no reporter or report without a report directory", () => {
    for (const command of landingCommands(plan, FIXTURE, [])) {
      assert.isUndefined(command.report);
      assert.isFalse(
        command.command.some(
          (argument) => argument.startsWith("--reporter") || argument.startsWith("--outputFile"),
        ),
      );
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
      "every test script is `vp test run ...`",
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
