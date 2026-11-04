// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - Evaluation-only host script (wall-clock measurements, pacing and files); not Effect services.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { estimateSeconds, readDurations } from "./baseline.ts";
import type { CallRecord, CaseFile } from "./run.ts";

const DIR = import.meta.dirname;
const durations = readDurations();
const out: Record<string, unknown> = {};

const results = NodeFS.readdirSync(NodePath.join(DIR, "results")).filter((f) =>
  /^(heldout|tuning|historical)-.*\.json$/.test(f),
);
for (const engine of ["jev", "luna"]) {
  const records = results
    .flatMap((f) =>
      (
        JSON.parse(NodeFS.readFileSync(NodePath.join(DIR, "results", f), "utf8"))
          .records as CallRecord[]
      ).map((r) => ({ f, ...r })),
    )
    .filter((r) => r.engine === engine);
  const ok = records.filter((r) => !r.errorCode);
  const sum = (g: (r: CallRecord) => number) => ok.reduce((a, r) => a + g(r), 0);
  out[engine] = {
    calls: records.length,
    failed: records.filter((r) => r.errorCode).length,
    meanServiceLatencyMs: Math.round(sum((r) => r.latencyMs ?? 0) / ok.length),
    meanWallMsPerCall: Math.round(sum((r) => r.wallMs) / ok.length),
    inputTokens: sum((r) => (r.usage as { inputTokens?: number })?.inputTokens ?? 0),
    estimatedUsd: Number(sum((r) => (r.cost as { usd?: number })?.usd ?? 0).toFixed(5)),
    questionsAnswered: sum((r) => r.answers?.length ?? 0),
  };
}
const dir = NodePath.join(DIR, "corpus/cases");
out.runtime = NodeFS.readdirSync(dir)
  .filter((f) => f.startsWith("seeded-"))
  .toSorted()
  .map((f) => {
    const c = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, f), "utf8")) as CaseFile & {
      measuredSeconds: Record<string, number>;
      measuredWallSeconds: number;
      subsampledFrom: number | null;
    };
    const workerSeconds = Object.values(c.measuredSeconds).reduce((a, b) => a + b, 0);
    const recorded = c.candidates.reduce((a, t) => a + (durations[t.file] ?? 2), 0);
    return {
      id: c.id.slice(7),
      candidates: c.candidates.length,
      subsampledFrom: c.subsampledFrom,
      gateEstimateWallSeconds: Math.round(estimateSeconds(c.candidates, durations)),
      recordedWorkerSeconds: Math.round(recorded),
      measuredWorkerSeconds: Math.round(workerSeconds),
      measuredWallSeconds: Math.round(c.measuredWallSeconds),
    };
  });
NodeFS.writeFileSync(NodePath.join(DIR, "results/costs.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
