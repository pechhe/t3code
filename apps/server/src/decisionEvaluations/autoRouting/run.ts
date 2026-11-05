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
import { BASELINE_VERSION } from "./baseline.ts";
import { HELDOUT_CASES } from "./corpusHeldout.ts";
import { TUNE_CASES } from "./corpusTune.ts";
import { corpusDigest, evaluate, runEvaluation, type CallRecord, type Engine } from "./harness.ts";
import { hasAllLabels, labelAudit, labelSources, referenceViews } from "./labels.ts";
import { POLICY } from "./policy.ts";
import {
  buildDigests,
  checkoutIdentity,
  runDigests,
  runtimeIdentity,
  scorerDigests,
} from "./provenance.ts";
import { RULE } from "./rule.ts";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (value === undefined) throw new Error(`Missing --${name}`);
  return value;
};

interface Retained {
  split: string;
  runAt: string;
  engines: Engine[];
  records: CallRecord[];
  run: unknown;
}

const rescore = process.argv.includes("--rescore");
const out = arg("out");
const previous = rescore ? (JSON.parse(NodeFS.readFileSync(out, "utf8")) as Retained) : undefined;
const split = previous?.split ?? arg("split");
const cases = split === "tune" ? TUNE_CASES : split === "heldout" ? HELDOUT_CASES : undefined;
if (cases === undefined) throw new Error("--split must be tune or heldout");
const engines = previous?.engines ?? (arg("engines", "jev,luna").split(",") as Engine[]);
const gapMs = Number(arg("gap-ms", "2000"));

// Labels must be complete before any live call is made.
const everyCase = [...TUNE_CASES, ...HELDOUT_CASES];
if (!hasAllLabels(everyCase)) throw new Error("Labels are incomplete; capture them before running");

// Keys come from the process environment (TYPESAFE_API_KEY, OPENAI_API_KEY); never read or print them here.
const live = DecisionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      FetchHttpClient.layer,
      Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
      NodeServices.layer,
      NodeCrypto.layer,
    ),
  ),
);

if (previous !== undefined) {
  const before = (previous.run as { files: Record<string, string> }).files;
  const now = runDigests();
  const changed = Object.keys({ ...before, ...now }).filter((f) => before[f] !== now[f]);
  if (changed.length > 0)
    throw new Error(
      `Cannot rescore: run files changed since the calls were made: ${changed.join(", ")}`,
    );
}
const logPath = `${out}.attempts.jsonl`;
const expected = { split, engines, corpusDigest: corpusDigest(cases), files: runDigests() };
const resuming = process.argv.includes("--resume");
const resumedLog =
  resuming && previous === undefined
    ? parseAttemptLog(NodeFS.readFileSync(logPath, "utf8"), expected)
    : undefined;
if (previous === undefined && !resuming && NodeFS.existsSync(logPath))
  throw new Error(`${logPath} exists from an earlier run: resume it with --resume or move it away`);
const run = previous?.run ??
  resumedLog?.identity ?? {
    checkout: checkoutIdentity(),
    runtime: runtimeIdentity(),
    files: expected.files,
  };
if (previous === undefined && resumedLog === undefined)
  NodeFS.writeFileSync(
    logPath,
    headerLine({
      ...expected,
      checkout: (run as { checkout: unknown }).checkout,
      runtime: (run as { runtime: unknown }).runtime,
    }),
  );
const records =
  previous?.records ??
  (await Effect.runPromise(
    runEvaluation(cases, engines, {
      gapMs,
      resumed: resumedLog?.records,
      // Each attempt is appended as it finishes, so a restart mid-run loses no record of a call that was made.
      onRecord: (record) => NodeFS.appendFileSync(logPath, recordLine(record)),
    }).pipe(Effect.provide(live)),
  ));
const views = referenceViews;
const results = evaluate(cases, records, views.agreed!(cases));
const report = {
  schema: "auto-routing-pilot-results-v1",
  split,
  rule: RULE,
  policy: POLICY,
  baselineVersion: BASELINE_VERSION,
  corpusDigest: corpusDigest(cases),
  corpusDigestAll: corpusDigest(everyCase),
  labels: labelSources,
  labelAudit: labelAudit(cases),
  runAt: previous?.runAt ?? new Date().toISOString(),
  engines,
  run,
  scorer: { files: scorerDigests(), build: buildDigests() },
  records,
  ...results,
  sensitivity: Object.fromEntries(
    Object.entries(views)
      .filter(([n]) => n !== "agreed")
      .map(([name, view]) => [name, evaluate(cases, records, view(cases)).summary]),
  ),
};
NodeFS.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ out, cost: results.cost }, null, 2));
