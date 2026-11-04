// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - Evaluation-only host script (wall-clock measurements, pacing and files); not Effect services.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { budgetInput, LANDING_BUDGET, readDurations } from "./baseline.ts";
import { makeDecide, readAuthorisedKeys, type Decide } from "./engine.ts";
import { buildRequest, CHUNK, type RuleName } from "./prompt.ts";

const DIR = import.meta.dirname;
export const HARD_CALL_CAP = 400;
// The shared service admits 60 per minute per server; stay under 45 so other agents keep headroom.
const PER_MINUTE = 45;
const admitted: number[] = [];
async function pace() {
  for (;;) {
    const now = Date.now();
    while (admitted.length > 0 && now - admitted[0]! >= 60_000) admitted.shift();
    if (admitted.length < PER_MINUTE) break;
    await new Promise((r) => setTimeout(r, 60_000 - (now - admitted[0]!) + 50));
  }
  admitted.push(Date.now());
}

export interface CaseFile {
  readonly id: string;
  readonly kind: "seeded" | "historical";
  readonly hunk?: string;
  readonly diff?: string;
  readonly changed: ReadonlyArray<string>;
  readonly candidates: ReadonlyArray<{ directory: string; file: string }>;
  readonly failing?: ReadonlyArray<string>;
  /** Tests that ran green under the mutation; every other non-failing candidate is unknown. */
  readonly verifiedPassing?: ReadonlyArray<string>;
}

export interface CallRecord {
  readonly caseId: string;
  readonly engine: "jev" | "luna";
  readonly rule: RuleName;
  readonly chunk: number;
  readonly questions: number;
  readonly digest?: string;
  readonly requestedModel?: string;
  readonly adapterVersion?: string;
  readonly latencyMs?: number;
  readonly wallMs: number;
  readonly usage?: unknown;
  readonly cost?: unknown;
  readonly errorCode?: string;
  readonly answers?: ReadonlyArray<{ file: string; status: string; probability?: number }>;
}

export function loadCases(): ReadonlyArray<CaseFile> {
  const dir = NodePath.join(DIR, "corpus/cases");
  return NodeFS.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .toSorted()
    .map((f) => JSON.parse(NodeFS.readFileSync(NodePath.join(dir, f), "utf8")) as CaseFile);
}

/** Scores every discretionary candidate of a case with one engine, in chunks of at most 32 questions. */
export async function scoreCase(
  decide: Decide,
  engine: "jev" | "luna",
  rule: RuleName,
  c: CaseFile,
  durations: Record<string, number>,
  calls: { count: number },
): Promise<ReadonlyArray<CallRecord>> {
  const { input } = budgetInput(
    c.candidates,
    { changed: c.changed, deleted: [] },
    durations,
    LANDING_BUDGET.seconds,
  );
  const optional = input.gateOrder.slice(input.mandatory);
  const records: CallRecord[] = [];
  for (let start = 0, chunk = 0; start < optional.length; start += CHUNK, chunk++) {
    if (calls.count >= HARD_CALL_CAP) throw new Error("call cap reached");
    calls.count++;
    await pace();
    const items = optional.slice(start, start + CHUNK).map((t) => ({
      file: t.file,
      rank: 2,
      seconds: durations[t.file],
    }));
    const request = buildRequest(
      engine,
      rule,
      { files: c.changed, diff: c.hunk ?? c.diff ?? "" },
      items,
    );
    const began = Date.now();
    const out = (await decide(request)) as
      | { ok: true; result: Record<string, any> }
      | { ok: false; error: { code?: string } };
    const wallMs = Date.now() - began;
    if (!out.ok) {
      records.push({
        caseId: c.id,
        engine,
        rule,
        chunk,
        questions: items.length,
        wallMs,
        errorCode: out.error.code ?? "unknown",
      });
      continue;
    }
    const r = out.result;
    records.push({
      caseId: c.id,
      engine,
      rule,
      chunk,
      questions: items.length,
      wallMs,
      digest: r.digest,
      requestedModel: r.requestedModel,
      adapterVersion: r.adapterVersion,
      latencyMs: r.latencyMs,
      usage: r.usage,
      cost: r.cost,
      answers: (r.answers as Array<{ id: string; status: string; probability?: number }>).map(
        (a) => ({
          file: items[Number(a.id.slice(1))]!.file,
          status: a.status,
          ...(a.probability === undefined ? {} : { probability: a.probability }),
        }),
      ),
    });
  }
  return records;
}

async function main(args: ReadonlyArray<string>) {
  const [split, rule = "v1", out, only] = args as [string, RuleName, string, string | undefined];
  const splits = JSON.parse(
    NodeFS.readFileSync(NodePath.join(DIR, "corpus/split.json"), "utf8"),
  ) as Record<string, string>;
  const cases = loadCases().filter(
    (c) => splits[c.id] === split && (only === undefined || new RegExp(only).test(c.id)),
  );
  const durations = readDurations();
  const decide = await makeDecide(readAuthorisedKeys());
  const calls = { count: 0 };
  const records: CallRecord[] = [];
  const target = NodePath.join(DIR, "results", out);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  for (const c of cases) {
    for (const engine of ["jev", "luna"] as const) {
      // Sequential and paced: one call at a time keeps well inside the shared 60/min admission window.
      records.push(...(await scoreCase(decide, engine, rule, c, durations, calls)));
      NodeFS.writeFileSync(target, JSON.stringify({ split, rule, records }, null, 1));
      await new Promise((r) => setTimeout(r, 1200));
    }
    console.log(`${c.id}: calls so far ${calls.count}`);
  }
  console.log(
    `done: ${calls.count} calls, ${records.filter((r) => r.errorCode).length} failed -> ${target}`,
  );
}
if (import.meta.main) await main(process.argv.slice(2));
