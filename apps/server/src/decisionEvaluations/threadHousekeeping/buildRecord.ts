// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - command-line tool that turns the private cases into the committed record
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { SAMPLING_RULE, casesDigest, publicProject, publicWake } from "./record.ts";
import type { PrivateCases } from "./types.ts";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i < 0 || process.argv[i + 1] === undefined) throw new Error(`Missing --${n}`);
  return process.argv[i + 1]!;
};
const priv = JSON.parse(NodeFS.readFileSync(arg("cases"), "utf8")) as PrivateCases;
const projects = [
  ...priv.projectHeldout.map((c) => publicProject(c, "heldout")),
  ...priv.projectTune.map((c) => publicProject(c, "tune")),
];
const wakes = [
  ...priv.wakeHeldout.map((c) => publicWake(c, "heldout")),
  ...priv.wakeTune.map((c) => publicWake(c, "tune")),
];
const turnFiles = process.argv.flatMap((a, i) => (a === "--turns" ? [process.argv[i + 1]!] : []));
const turns: Record<string, { model: string | null; ms: number | null; items: number | null }> =
  Object.assign({}, ...turnFiles.map((f) => JSON.parse(NodeFS.readFileSync(f, "utf8"))));
const median = (xs: number[]) =>
  xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
/** What the state database records of the turn each sampled wake started. It records no token spend per turn, so the spend is unknown. */
const replacedTurns = Object.fromEntries(
  [...new Set(wakes.map((w) => w.wakeKind))].sort().map((kind) => {
    const own = wakes.filter((w) => w.wakeKind === kind).flatMap((w) => turns[w.caseId] ?? []);
    const models: Record<string, number> = {};
    for (const t of own)
      models[t.model ?? "unrecorded"] = (models[t.model ?? "unrecorded"] ?? 0) + 1;
    return [
      kind,
      {
        turns: own.length,
        models,
        wallMsMedian: median(own.flatMap((t) => t.ms ?? [])),
        wallMsTotal: own.reduce((n, t) => n + (t.ms ?? 0), 0),
        itemsMedian: median(own.flatMap((t) => t.items ?? [])),
        tokenSpendRecorded: false,
        spendUsd: "unknown",
      },
    ];
  }),
);
const record = {
  schema: "thread-housekeeping-cases-v1",
  samplingRule: SAMPLING_RULE,
  population: priv.audit,
  replacedTurns,
  digest: casesDigest([...projects, ...wakes]),
  projects,
  wakes,
};
NodeFS.writeFileSync(
  NodePath.join(here, "results/cases.json"),
  `${JSON.stringify(record, null, 2)}\n`,
);
console.log(
  JSON.stringify({ projects: projects.length, wakes: wakes.length, digest: record.digest }),
);
