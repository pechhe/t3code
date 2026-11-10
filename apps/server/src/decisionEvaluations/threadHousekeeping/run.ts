// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - command-line entry point, not server code
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as NodeFS from "node:fs";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as DecisionService from "../../decisions/DecisionService.ts";
import { headerLine, parseAttemptLog, recordLine } from "./attemptLog.ts";
import { BASELINE_VERSION, catchKindsFromTune } from "./baseline.ts";
import { evaluate, runEvaluation, type CallRecord } from "./harness.ts";
import { agreedLabels, hasAllLabels, type LabelFile } from "./labels.ts";
import { POLICY } from "./policy.ts";
import {
  buildDigests,
  checkoutIdentity,
  runDigests,
  runtimeIdentity,
  scorerDigests,
} from "./provenance.ts";
import { casesDigest, publicProject, publicWake } from "./record.ts";
import cases from "./results/cases.json" with { type: "json" };
import labelsA from "./results/labels-A.json" with { type: "json" };
import labelsB from "./results/labels-B.json" with { type: "json" };
import { RULE } from "./rule.ts";
import type { Chore, Engine, PrivateCases, ProjectPublic, Split, WakePublic } from "./types.ts";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (value === undefined) throw new Error(`Missing --${name}`);
  return value;
};

interface Retained {
  split: Split;
  chore: Chore | "both";
  runAt: string;
  engines: Engine[];
  records: CallRecord[];
  run: unknown;
}

const rescore = process.argv.includes("--rescore");
const out = arg("out");
const previous = rescore ? (JSON.parse(NodeFS.readFileSync(out, "utf8")) as Retained) : undefined;
const split = (previous?.split ?? arg("split")) as Split;
const chore = (previous?.chore ?? arg("chore", "both")) as Chore | "both";
const engines = previous?.engines ?? (arg("engines", "jev,luna").split(",") as Engine[]);
const gapMs = Number(arg("gap-ms", "2000"));
if (split !== "heldout" && split !== "tune") throw new Error("--split must be tune or heldout");

const projectsPublic = (cases.projects as ProjectPublic[]).filter(
  (c) => c.split === split && chore !== "wake",
);
const wakesPublic = (cases.wakes as WakePublic[]).filter(
  (c) => c.split === split && chore !== "project",
);
const everyPublic = [...cases.projects, ...cases.wakes] as ReadonlyArray<{
  caseId: string;
  digest: string;
}>;
const ids = [...cases.projects, ...cases.wakes].map((c) => c.caseId);
const A = labelsA as LabelFile;
const B = labelsB as LabelFile;
if (!hasAllLabels(A, B, ids)) throw new Error("Labels are incomplete; capture them before running");
const labels = agreedLabels(A, B, ids);
const tuneCatchKinds = catchKindsFromTune(
  (cases.wakes as WakePublic[])
    .filter((c) => c.split === "tune")
    .map((c) => ({ kind: c.wakeKind, label: labels[c.caseId]! })),
);

const selected = [...projectsPublic, ...wakesPublic];
const selectedDigest = casesDigest(selected);
const files = runDigests();
const logPath = `${out}.attempts.jsonl`;
const resuming = process.argv.includes("--resume");

let records: CallRecord[];
let run: unknown;
if (previous !== undefined) {
  const before = (previous.run as { files: Record<string, string> }).files;
  const changed = Object.keys({ ...before, ...files }).filter((f) => before[f] !== files[f]);
  if (changed.length > 0)
    throw new Error(
      `Cannot rescore: run files changed since the calls were made: ${changed.join(", ")}`,
    );
  records = previous.records;
  run = previous.run;
} else {
  // Private cases hold real thread text: they come from a local file outside the repository and must match the committed digests.
  const priv = JSON.parse(NodeFS.readFileSync(arg("cases"), "utf8")) as PrivateCases;
  const privProjects = split === "heldout" ? priv.projectHeldout : priv.projectTune;
  const privWakes = split === "heldout" ? priv.wakeHeldout : priv.wakeTune;
  const digestOfCommitted = new Map(everyPublic.map((c) => [c.caseId, c.digest]));
  for (const c of privProjects)
    if (digestOfCommitted.get(c.caseId) !== publicProject(c, split).digest)
      throw new Error(`Private case ${c.caseId} does not match the committed digest`);
  for (const c of privWakes)
    if (digestOfCommitted.get(c.caseId) !== publicWake(c, split).digest)
      throw new Error(`Private case ${c.caseId} does not match the committed digest`);
  const input = {
    projects: chore === "wake" ? [] : privProjects,
    wakes: chore === "project" ? [] : privWakes,
  };
  if (input.projects.length !== projectsPublic.length || input.wakes.length !== wakesPublic.length)
    throw new Error("The private cases do not cover the committed ones");

  const live = DecisionService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FetchHttpClient.layer,
        // Keys come from the process environment (TYPESAFE_API_KEY, OPENAI_API_KEY); never read or print them here.
        Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  );
  const expected = { split, chore, engines, casesDigest: selectedDigest, files };
  const resumedLog = resuming
    ? parseAttemptLog(NodeFS.readFileSync(logPath, "utf8"), expected)
    : undefined;
  if (!resuming && NodeFS.existsSync(logPath))
    throw new Error(
      `${logPath} exists from an earlier run: resume it with --resume or move it away`,
    );
  run = resumedLog?.identity ?? { checkout: checkoutIdentity(), runtime: runtimeIdentity(), files };
  if (resumedLog === undefined)
    NodeFS.writeFileSync(
      logPath,
      headerLine({
        ...expected,
        checkout: (run as { checkout: unknown }).checkout,
        runtime: (run as { runtime: unknown }).runtime,
      }),
    );
  records = await Effect.runPromise(
    runEvaluation(input, engines, {
      gapMs,
      resumed: resumedLog?.records,
      // Each attempt is appended as it finishes, so a restart mid-run loses no record of a call that was made.
      onRecord: (record) => NodeFS.appendFileSync(logPath, recordLine(record)),
    }).pipe(Effect.provide(live)),
  );
}

const results = evaluate(
  { projects: projectsPublic, wakes: wakesPublic, labels, tuneCatchKinds },
  records,
  engines,
);
const report = {
  schema: "thread-housekeeping-pilot-results-v1",
  split,
  chore,
  rule: RULE,
  policy: POLICY,
  baselineVersion: BASELINE_VERSION,
  tuneCatchKinds: [...tuneCatchKinds].sort(),
  casesDigest: selectedDigest,
  runAt: previous?.runAt ?? new Date().toISOString(),
  engines,
  run,
  scorer: { files: scorerDigests(), build: buildDigests() },
  labelSources: { A: A.source, B: B.source },
  records,
  ...results,
};
NodeFS.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ out, cost: results.cost }, null, 2));
