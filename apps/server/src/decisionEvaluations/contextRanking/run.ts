// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - command-line entry point, not server code
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as NodeFS from "node:fs";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as DecisionService from "../../decisions/DecisionService.ts";
import { BASELINE_VERSION } from "./baseline.ts";
import { HELDOUT_CASES } from "./corpusHeldout.ts";
import { TUNE_CASES } from "./corpusTune.ts";
import { corpusDigest, evaluate, runEvaluation, type CallRecord, type Engine } from "./harness.ts";
import { hasAllLabels, labelSources, labelViews, primaryView } from "./labels.ts";
import {
  buildDigests,
  checkoutIdentity,
  runDigests,
  runtimeIdentity,
  scorerDigests,
} from "./provenance.ts";
import { RULE, THRESHOLD, TOKEN_BUDGET, TOP_K } from "./rule.ts";

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
const previous = rescore
  ? (JSON.parse(NodeFS.readFileSync(arg("out"), "utf8")) as Retained)
  : undefined;
const split = previous?.split ?? arg("split");
const cases = split === "tune" ? TUNE_CASES : split === "heldout" ? HELDOUT_CASES : undefined;
if (cases === undefined) throw new Error("--split must be tune or heldout");
const engines = previous?.engines ?? (arg("engines", "jev,luna").split(",") as Engine[]);
const out = arg("out");
const gapMs = Number(arg("gap-ms", "1500"));

// Labels must be complete, and captured against exactly this corpus, before any live call is made.
const everyCase = [...TUNE_CASES, ...HELDOUT_CASES];
const digestOfAll = corpusDigest(everyCase);
for (const [labeler, source] of Object.entries(labelSources)) {
  if (source.corpusDigest !== digestOfAll)
    throw new Error(`Labeler ${labeler} labelled a different corpus than this checkout holds`);
}
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

// A rescore reads old calls with the current code, so the code that decides what was asked must still be the code that asked it.
if (previous !== undefined) {
  const before = (previous.run as { files: Record<string, string> }).files;
  const now = runDigests();
  const changed = Object.keys({ ...before, ...now }).filter((f) => before[f] !== now[f]);
  if (changed.length > 0)
    throw new Error(
      `Cannot rescore: run files changed since the calls were made: ${changed.join(", ")}`,
    );
}
const run = previous?.run ?? {
  checkout: checkoutIdentity(),
  runtime: runtimeIdentity(),
  files: runDigests(),
};
const records =
  previous?.records ??
  (await Effect.runPromise(runEvaluation(cases, engines, { gapMs }).pipe(Effect.provide(live))));
const results = evaluate(cases, records, primaryView);
const report = {
  schema: "context-ranking-pilot-results-v1",
  split,
  rule: RULE,
  declared: { topK: TOP_K, threshold: THRESHOLD, tokenBudgetEstimate: TOKEN_BUDGET },
  baselineVersion: BASELINE_VERSION,
  corpusDigest: corpusDigest(cases),
  corpusDigestAll: digestOfAll,
  labels: labelSources,
  runAt: previous?.runAt ?? new Date().toISOString(),
  engines,
  run,
  scorer: { files: scorerDigests(), build: buildDigests() },
  records,
  ...results,
  sensitivity: Object.fromEntries(
    Object.entries(labelViews).map(([name, view]) => [
      name,
      evaluate(cases, records, view).systems,
    ]),
  ),
};
NodeFS.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ out, cost: results.cost }, null, 2));
