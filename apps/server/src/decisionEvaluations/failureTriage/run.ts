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
import { labelViews, supportedLabel } from "./labels.ts";
import { checkoutIdentity, runDigests, scorerDigests } from "./provenance.ts";
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
const previous = rescore
  ? (JSON.parse(NodeFS.readFileSync(arg("out"), "utf8")) as Retained)
  : undefined;
const split = previous?.split ?? arg("split");
const cases = split === "tune" ? TUNE_CASES : split === "heldout" ? HELDOUT_CASES : undefined;
if (cases === undefined) throw new Error("--split must be tune or heldout");
const engines = previous?.engines ?? (arg("engines", "jev,luna").split(",") as Engine[]);
const out = arg("out");
const gapMs = Number(arg("gap-ms", "1500"));

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

// The run identity describes the code that made the calls. A rescore keeps it and records the scorer that produced the numbers.
const run = previous?.run ?? {
  checkout: checkoutIdentity(),
  files: runDigests(),
};
const records =
  previous?.records ??
  (await Effect.runPromise(runEvaluation(cases, engines, { gapMs }).pipe(Effect.provide(live))));
const results = evaluate(cases, records, (id) => supportedLabel(id));
const report = {
  schema: "failure-triage-pilot-results-v1",
  split,
  rule: RULE,
  baselineVersion: BASELINE_VERSION,
  corpusDigest: corpusDigest(cases),
  runAt: previous?.runAt ?? new Date().toISOString(),
  engines,
  run,
  scorer: { files: scorerDigests() },
  records,
  ...results,
  sensitivity:
    split === "heldout"
      ? Object.fromEntries(
          Object.entries(labelViews).map(([name, view]) => [
            name,
            evaluate(cases, records, view).systems,
          ]),
        )
      : undefined,
};
NodeFS.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ out, systems: results.systems, cost: results.cost }, null, 2));
