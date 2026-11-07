// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Lists and runs test files through Vitest's Node API in a child process.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

/** The `vp test run` flags this module reproduces; a workspace whose script passes any other runs whole. */
export const VITEST_FLAGS = ["--config", "--dir", "--project", "--passWithNoTests"] as const;

export interface VitestWorkspace {
  /** The tree to work in: the repository root, or a rehydrated copy of it. */
  readonly root: string;
  readonly directory: string;
  /** The `vp test run` flags of the workspace's test script. */
  readonly flags: ReadonlyArray<string>;
}

export interface ListRequest extends VitestWorkspace {
  /** Repository-relative files; lists the tests that import them. Lists every test without it. */
  readonly related?: ReadonlyArray<string>;
}

export interface RunRequest extends VitestWorkspace {
  /** Repository-relative test files to run, exactly; the whole suite without it. */
  readonly files?: ReadonlyArray<string>;
  /** Repository-relative test files to leave out: the gate's quarantine. */
  readonly exclude?: ReadonlyArray<string>;
  readonly workers: number;
  /** Where to write a Vitest JSON report. */
  readonly reportFile?: string;
}

/** The flag values a workspace's `vp test run` script passes that choose its Vitest projects. */
function flagValues(flags: ReadonlyArray<string>, name: string) {
  return flags.flatMap((flag, index) =>
    flag === name && flags[index + 1] ? [flags[index + 1]!] : [],
  );
}

/** Where this process spent its time, so the gate's log separates Vitest setup from running tests. */
const phases = { contexts: 0, load: 0, discovery: 0, tests: 0, close: 0 };

async function timed<T>(phase: Exclude<keyof typeof phases, "contexts">, work: () => Promise<T>) {
  const started = performance.now();
  try {
    return await work();
  } finally {
    phases[phase] += performance.now() - started;
  }
}

function phaseSummary(mode: "list" | "run", directory: string) {
  const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(1)}s`;
  return (
    `Vitest ${mode} ${directory}: ${phases.contexts} context${phases.contexts === 1 ? "" : "s"}; ` +
    `load ${seconds(phases.load)}, discovery ${seconds(phases.discovery)}, ` +
    `tests ${seconds(phases.tests)}, close ${seconds(phases.close)}`
  );
}

async function vitest(
  { root, directory: workspaceDirectory, flags }: VitestWorkspace,
  options: Record<string, unknown>,
) {
  const { createVitest } = await import("vite-plus/test/node");
  const directory = NodePath.join(root, workspaceDirectory);
  const config = flagValues(flags, "--config")[0];
  const dir = flagValues(flags, "--dir")[0];
  const projects = flagValues(flags, "--project");
  phases.contexts += 1;
  return timed("load", () =>
    createVitest(
      "test",
      {
        root: directory,
        watch: false,
        run: true,
        ...(config ? { config: NodePath.resolve(directory, config) } : {}),
        ...(dir ? { dir: NodePath.resolve(directory, dir) } : {}),
        ...(projects.length > 0 ? { project: projects } : {}),
        ...options,
      },
      {},
    ),
  );
}

const repositoryPath = (root: string, file: string) =>
  NodePath.relative(root, file).replaceAll("\\", "/");

async function listInProcess(request: ListRequest) {
  const { root, related } = request;
  const context = await vitest(
    request,
    related ? { related: related.map((file) => NodePath.join(root, file)) } : {},
  );
  try {
    const specifications = await timed("discovery", () =>
      related ? context.getRelevantTestSpecifications() : context.globTestSpecifications(),
    );
    // A file in two projects (web's unit and browser) is one file to run.
    return [
      ...new Set(
        specifications.map((specification) => repositoryPath(root, specification.moduleId)),
      ),
    ].toSorted();
  } finally {
    await timed("close", () => context.close());
  }
}

/**
 * Runs exactly the requested files. Vitest's CLI filters match by prefix and substring, so
 * `a.test.ts` would also run `a.test.tsx`; specifications match by module id.
 */
async function selected(context: Awaited<ReturnType<typeof vitest>>, request: RunRequest) {
  const { root, files, exclude = [] } = request;
  const wanted = files ? new Set(files) : undefined;
  const excluded = new Set(exclude);
  return (await context.globTestSpecifications()).filter((specification) => {
    const file = repositoryPath(root, specification.moduleId);
    return (!wanted || wanted.has(file)) && !excluded.has(file);
  });
}

/**
 * Vitest exits on a rejection outside any test, losing the failure behind it, the summary and the
 * report: a browser page that dies rejects its pending mock routes, so the pool's own error never
 * printed (T3-338). Keep the run going instead: print and fail here, since a rejection during
 * teardown arrives after the run's result, and record it for a summary still to come.
 */
function recordRejectionsOnRun(context: Awaited<ReturnType<typeof vitest>>) {
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (reason) => {
    process.exitCode = 1;
    // Not Vitest's printer: formatting a stack during teardown can crash it.
    console.error(`Unhandled Rejection: ${String(reason)}`);
    context.state.catchError(reason, "Unhandled Rejection");
  });
}

/** One Vitest context: it finds the files, chooses their projects, runs them and closes. */
async function runInProcess(request: RunRequest) {
  const { root, files, exclude = [], workers, reportFile } = request;
  // A workspace whose every test is quarantined has nothing left to run.
  const passWithNoTests = request.flags.includes("--passWithNoTests") || exclude.length > 0;
  const context = await vitest(request, {
    fileParallelism: true,
    maxWorkers: workers,
    passWithNoTests: true,
    reporters: reportFile ? ["default", "json"] : ["default"],
    ...(reportFile ? { outputFile: { json: reportFile } } : {}),
  });
  recordRejectionsOnRun(context);
  const projects = context.projects;
  try {
    const specifications = await timed("discovery", () => selected(context, request));
    const found = new Set(
      specifications.map((specification) => repositoryPath(root, specification.moduleId)),
    );
    const missing = (files ?? []).filter((file) => !found.has(file) && !exclude.includes(file));
    if (missing.length > 0)
      throw new Error(`Not test files of ${request.directory}: ${missing.join(" ")}`);
    if (specifications.length === 0) {
      if (passWithNoTests) return 0;
      throw new Error(`No test files found in ${request.directory}`);
    }
    // A browser project that runs no file never closes, so the run starts only the projects it
    // uses, as `--project` would have; closing still tears every project down.
    const used = new Set(specifications.map((specification) => specification.project));
    context.projects = projects.filter((project) => used.has(project));
    const result = await timed("tests", async () => {
      // Starts the reporters and coverage, as `vitest run` does before its first run.
      await context.standalone();
      return context.runTestSpecifications(specifications, !files);
    });
    const failed =
      result.unhandledErrors.length > 0 ||
      result.testModules.some((module) => module.state() === "failed");
    return failed ? 1 : 0;
  } finally {
    context.projects = projects;
    await timed("close", () => context.close());
  }
}

/** Runs in a child process: one Vitest context per process keeps a long replay from exhausting the heap. */
export function listTests(request: ListRequest) {
  return new Promise<ReadonlyArray<string>>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["--max-old-space-size=8192", import.meta.filename, "list", JSON.stringify(request)],
      // The root config adds per-package projects only when run from the repo root, so a
      // workspace borrowing it lists from its own directory, as its runs do.
      {
        cwd: NodePath.join(request.root, request.directory),
        stdio: ["ignore", "pipe", "inherit"],
        env: { ...process.env, T3_TEST_CACHE_DIR: privateCacheDir() },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const listed = /^FILES (.*)$/m.exec(output)?.[1];
      if (code === 0 && listed) resolve(JSON.parse(listed) as ReadonlyArray<string>);
      else reject(new Error(`listing tests in ${request.directory} exited ${code}`));
    });
  });
}

/** A cache directory owned by one child process, so concurrent Vite runs never share one. */
let cacheDirSequence = 0;

function privateCacheDir() {
  cacheDirSequence += 1;
  return NodePath.join("node_modules/.vitest-cache", `run-${process.pid}-${cacheDirSequence}`);
}

/** The command that runs a request in its own process, from any directory. */
export function runCommand(request: RunRequest) {
  return ["node", import.meta.filename, "run", JSON.stringify(request)];
}

/** Maps a few items at a time, keeping their order. */
export async function mapConcurrently<T, R>(
  items: ReadonlyArray<T>,
  map: (item: T) => Promise<R>,
  limit = 3,
) {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await map(items[index]!);
      }
    }),
  );
  return results;
}

if (import.meta.main) {
  const [mode, request] = process.argv.slice(2);
  if (mode === "list") {
    const list = JSON.parse(request!) as ListRequest;
    console.log(`FILES ${JSON.stringify(await listInProcess(list))}`);
    console.error(phaseSummary("list", list.directory));
  } else if (mode === "run") {
    const run = JSON.parse(request!) as RunRequest;
    const exit = await runInProcess(run).finally(() =>
      console.error(phaseSummary("run", run.directory)),
    );
    // Vitest reports a teardown failure in `close()` through the exit code alone; keep it.
    if (exit !== 0) process.exitCode = exit;
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
}
