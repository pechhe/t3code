// @effect-diagnostics nodeBuiltinImport:off - hashes synthetic locks and manifests
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import {
  CALL_PATH_PACKAGES,
  LOCK_FILE,
  retainedRunProblems,
  type ReadFileAt,
} from "./retainedRunIdentity.ts";

const sha = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const HEAD = "a".repeat(40);

const lockOf = (entries: ReadonlyArray<readonly [string, string]>) => {
  const row = ([name, version]: readonly [string, string]) =>
    `  '${name}@${version}':\n    resolution: {integrity: sha512-x}\n`;
  return (
    "---\nlockfileVersion: '9.0'\n\npackages:\n\n" +
    entries.map(row).join("\n") +
    "\nsnapshots:\n\n" +
    entries.map(row).join("\n")
  );
};

const CALL_PATH = CALL_PATH_PACKAGES.map(
  (name) => [name, name === "undici" ? "8.11.2" : "4.1.2"] as const,
);
const CODE = "apps/server/src/decisions/DecisionService.ts";
const CORPUS = "apps/server/src/decisionEvaluations/autoRouting/run.ts";
const codeText = "export const DecisionService = 1;\n";
const corpusText = "export const run = 1;\n";

const runLock = lockOf([...CALL_PATH, ["left-pad", "1.0.0"]]);
const currentLock = lockOf([...CALL_PATH, ["left-pad", "1.0.0"]]);

const manifest = (lock: string): Record<string, string> => ({
  [CODE]: sha(codeText),
  [CORPUS]: sha(corpusText),
  [LOCK_FILE]: sha(lock),
});

const clean = (): {
  run: { head: string; files: Record<string, string> };
  current: Record<string, string>;
} => ({
  run: { head: HEAD, files: manifest(runLock) },
  current: manifest(currentLock),
});

/** A reader over what git shows at the run's commit and what the working tree has. */
const reader =
  (atRun: Record<string, string>, now: Record<string, string>): ReadFileAt =>
  (path, revision) => {
    const text = (revision === undefined ? now : atRun)[path];
    return text === undefined ? undefined : Buffer.from(text);
  };

const problemsOf = ({
  run,
  current,
  atRun = { [LOCK_FILE]: runLock },
  now = { [LOCK_FILE]: currentLock },
}: {
  run: { head: string; files: Record<string, string> };
  current: Record<string, string>;
  atRun?: Record<string, string>;
  now?: Record<string, string>;
}) => retainedRunProblems(run, current, reader(atRun, now));

describe("a retained run's identity", () => {
  it("holds when its lock and manifest are the ones on the tree", () => {
    expect(problemsOf(clean())).toEqual([]);
  });

  it("holds when a later lock changed only packages off the decision call path", () => {
    const changed = lockOf([...CALL_PATH, ["left-pad", "1.0.1"]]);
    const { run } = clean();
    expect(
      problemsOf({
        run,
        current: manifest(changed),
        atRun: { [LOCK_FILE]: runLock },
        now: { [LOCK_FILE]: changed },
      }),
    ).toEqual([]);
  });

  it("catches a lock digest no lock at the run's commit has", () => {
    const { run, current } = clean();
    run.files[LOCK_FILE] = sha("a different lock");
    const problems = problemsOf({ run, current });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(LOCK_FILE);
  });

  it("catches a digest rewritten to the current lock", () => {
    const later = lockOf([...CALL_PATH, ["left-pad", "1.0.1"]]);
    const { run } = clean();
    run.files[LOCK_FILE] = sha(later);
    const problems = problemsOf({
      run,
      current: manifest(later),
      atRun: { [LOCK_FILE]: runLock },
      now: { [LOCK_FILE]: later },
    });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(LOCK_FILE);
  });

  it("catches a manifest with no lock digest", () => {
    const { run, current } = clean();
    delete (run.files as Record<string, string>)[LOCK_FILE];
    delete (current as Record<string, string>)[LOCK_FILE];
    const problems = problemsOf({ run, current });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(LOCK_FILE);
  });

  it("catches a commit git cannot show", () => {
    const { run, current } = clean();
    const problems = problemsOf({ run, current, atRun: {} });
    expect(problems).toEqual([`${LOCK_FILE} is missing at the run's commit ${HEAD}`]);
  });

  it("catches a code file that changed after the run", () => {
    const { run, current } = clean();
    current[CODE] = sha("export const DecisionService = 2;\n");
    expect(problemsOf({ run, current })).toEqual([`${CODE} changed since the run`]);
  });

  it("catches a manifest key that is missing and one that is extra", () => {
    const { run, current } = clean();
    delete (current as Record<string, string>)[CORPUS];
    current["apps/server/src/decisions/adapters.ts"] = sha("new");
    const problems = problemsOf({ run, current });
    expect(problems).toEqual([
      `${CORPUS} is missing from the current manifest`,
      "apps/server/src/decisions/adapters.ts is not in the run's manifest",
    ]);
  });

  it("catches a call-path package that moved, naming it and both versions", () => {
    const moved = lockOf([
      ...CALL_PATH.filter(([name]) => name !== "effect"),
      ["effect", "4.1.3"],
      ["left-pad", "1.0.0"],
    ]);
    const { run } = clean();
    const problems = problemsOf({
      run,
      current: manifest(moved),
      atRun: { [LOCK_FILE]: runLock },
      now: { [LOCK_FILE]: moved },
    });
    expect(problems).toEqual([`effect moved from 4.1.2 at ${HEAD} to 4.1.3 now`]);
  });

  it("catches a call-path package absent from either lock", () => {
    const withoutUndici = lockOf(CALL_PATH.filter(([name]) => name !== "undici"));
    const { run } = clean();
    const absentAtRun = problemsOf({
      run: { head: HEAD, files: { ...run.files, [LOCK_FILE]: sha(withoutUndici) } },
      current: manifest(currentLock),
      atRun: { [LOCK_FILE]: withoutUndici },
      now: { [LOCK_FILE]: currentLock },
    });
    expect(absentAtRun).toEqual([`undici is not in ${LOCK_FILE} at ${HEAD}`]);
    const absentNow = problemsOf({
      run,
      current: { ...manifest(currentLock), [LOCK_FILE]: sha(withoutUndici) },
      atRun: { [LOCK_FILE]: runLock },
      now: { [LOCK_FILE]: withoutUndici },
    });
    expect(absentNow).toEqual(["undici is not in the current " + LOCK_FILE]);
  });
});
