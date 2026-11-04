// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - Evaluation-only host script (wall-clock measurements, pacing and files); not Effect services.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { runCommand } from "../../lib/test-landing-vitest.ts";
import { checkoutWorkspaces, ROOT } from "./baseline.ts";
import { applyMutation, type Mutation } from "./mutate.ts";

export interface FileResult {
  readonly status: "passed" | "failed";
  /** Reported duration; worker time, not wall time. */
  readonly seconds: number;
}

export interface LabelRun {
  readonly results: Record<string, FileResult>;
  readonly wallSeconds: number;
  readonly exitCodes: Record<string, number>;
}

/** Runs exact test files per workspace with the gate's own Vitest wrapper and reads its JSON reports. */
export function runFiles(
  tests: ReadonlyArray<{ directory: string; file: string }>,
  workers: number,
): LabelRun {
  const workspaces = checkoutWorkspaces();
  const reportDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-test-selection-"));
  const results: Record<string, FileResult> = {};
  const exitCodes: Record<string, number> = {};
  const started = Date.now();
  try {
    for (const directory of new Set(tests.map((t) => t.directory))) {
      const workspace = workspaces.find((w) => w.directory === directory);
      if (!workspace || typeof workspace.test !== "object") continue;
      const reportFile = NodePath.join(reportDir, `${directory.replaceAll("/", "-")}.json`);
      const command = runCommand({
        root: ROOT,
        directory,
        flags: workspace.test.flags,
        files: tests.filter((t) => t.directory === directory).map((t) => t.file),
        workers,
        reportFile,
      });
      // The child gets a scrubbed environment: no decision keys can reach a test process.
      const { TYPESAFE_API_KEY: _a, OPENAI_API_KEY: _b, ...env } = process.env;
      const run = NodeChildProcess.spawnSync(command[0]!, command.slice(1), {
        cwd: NodePath.join(ROOT, directory),
        env,
        stdio: ["ignore", "ignore", "ignore"],
        maxBuffer: 1 << 28,
      });
      exitCodes[directory] = run.status ?? -1;
      if (!NodeFS.existsSync(reportFile)) continue;
      const report = JSON.parse(NodeFS.readFileSync(reportFile, "utf8")) as {
        testResults: ReadonlyArray<{
          name: string;
          status: string;
          startTime: number;
          endTime: number;
        }>;
      };
      for (const result of report.testResults) {
        results[NodePath.relative(ROOT, result.name)] = {
          status: result.status === "passed" ? "passed" : "failed",
          seconds: Math.max(0, (result.endTime - result.startTime) / 1000),
        };
      }
    }
  } finally {
    NodeFS.rmSync(reportDir, { recursive: true, force: true });
  }
  return { results, wallSeconds: (Date.now() - started) / 1000, exitCodes };
}

/** Applies a mutation for the duration of `body`, always restoring the original bytes. */
export function withMutation<T>(mutation: Mutation, body: () => T): T {
  const path = NodePath.join(ROOT, mutation.file);
  const original = NodeFS.readFileSync(path, "utf8");
  const restore = () => NodeFS.writeFileSync(path, original);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      restore();
      process.exit(130);
    });
  NodeFS.writeFileSync(path, applyMutation(original, mutation));
  try {
    return body();
  } finally {
    restore();
  }
}
