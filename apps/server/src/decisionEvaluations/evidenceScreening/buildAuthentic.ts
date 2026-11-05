// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - offline corpus builder: reads retained git objects and writes corpusAuthentic.json
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repoRoot = NodePath.resolve(here, "../../../../..");
const EVAL = "apps/server/src/decisionEvaluations";

const git = (...args: string[]): string =>
  NodeChildProcess.execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
const show = (sha: string, path: string) => git("show", `${sha}:${path}`);
const json = (sha: string, path: string) => JSON.parse(show(sha, path)) as Record<string, any>;

/** Evidence blocks are the output of fixed extractors over retained objects, each headed by what was run. */
const block = (command: string, output: string) => `$ ${command}\n${output.trimEnd()}`;
const testCount = (sha: string, path: string) => {
  const n = show(sha, path)
    .split("\n")
    .filter((l) => /^\s*(it|test)(\.effect|\.each)?\(/.test(l)).length;
  return block(`count it()/test() declarations in ${path} at ${sha.slice(0, 10)}`, `${n} tests`);
};
const changedFiles = (sha: string) =>
  block(
    `git show --name-only --format= ${sha.slice(0, 10)}`,
    git("show", "--name-only", "--format=", sha),
  );
const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

const runFacts = (sha: string, path: string, label: string) => {
  const d = json(sha, path);
  const records = d.records as Array<{ outcome: { kind: string } }>;
  const kinds = new Map<string, number>();
  for (const r of records) kinds.set(r.outcome.kind, (kinds.get(r.outcome.kind) ?? 0) + 1);
  return block(
    `summarise records[] in ${path} at ${sha.slice(0, 10)} (${label})`,
    `attempts: ${records.length}\n${[...kinds].map(([k, v]) => `outcome ${k}: ${v}`).join("\n")}`,
  );
};

const auditFacts = (date: string) => {
  const a = json("35dbb6ea3f", `${EVAL}/failureTriage/corpusAuthentic.json`)[date] as Record<
    string,
    any
  >;
  const tests = (a.failingTests as string[]).slice(0, 12);
  return block(
    `retained nightly audit record for ${date}`,
    [
      `check: ${a.check}`,
      `exit status: ${a.exitStatus}`,
      `failure kind: ${a.failureKind}`,
      `failing tests (${(a.failingTests as string[]).length}): ${tests.length === 0 ? "none listed" : tests.join(" | ")}`,
      `first error: ${String(a.firstError).slice(0, 300)}`,
      `last output (${String(a.outputTail).slice(-900).length} chars): ${String(a.outputTail).slice(-900)}`,
    ].join("\n"),
  );
};

interface Spec {
  id: string;
  split: "tune" | "heldout";
  family: string;
  stratum: "authentic" | "reconstructed";
  tags: string[];
  claim: string;
  provenance: string;
  evidence: () => string;
}

const T356 = "35dbb6ea3f";
const T357 = "ad11898066";
const T359 = "a09b228bdf";
const T355 = "c44a2d5d39";
const CR = `${EVAL}/contextRanking`;
const FT = `${EVAL}/failureTriage`;
const AR = `${EVAL}/autoRouting`;

const SPECS: Spec[] = [
  {
    id: "h-t359-checks",
    split: "heldout",
    family: "t3-359",
    stratum: "authentic",
    tags: ["partial-claim"],
    claim: "Checks: 14 focused tests, server typecheck, fmt and lint clean.",
    provenance: "T3-359 close report (found), checked against the landed test file",
    evidence: () =>
      [
        testCount(T359, `${AR}/autoRouting.test.ts`),
        changedFiles(T359).split("\n").slice(0, 8).join("\n"),
      ].join("\n\n"),
  },
  {
    id: "h-t359-reliability",
    split: "heldout",
    family: "t3-359",
    stratum: "authentic",
    tags: ["caveat"],
    claim:
      "Three full held-out passes (256 attempts each, no call failed, Luna returned the same refusal for one workflow question each time).",
    provenance: "T3-359 close report (found), checked against the three retained runs",
    evidence: () =>
      [
        runFacts(T359, `${AR}/results/first-run/heldout.json`, "first pass"),
        runFacts(T359, `${AR}/results/second-run/heldout.json`, "second pass"),
        runFacts(T359, `${AR}/results/heldout.json`, "third pass"),
      ].join("\n\n"),
  },
  {
    id: "h-t359-scope",
    split: "heldout",
    family: "t3-359",
    stratum: "authentic",
    tags: [],
    claim:
      "One landing in pechhe/t3code, a09b228bdf, entirely under apps/server/src/decisionEvaluations/autoRouting (no production, role, default, UI or contract change).",
    provenance: "T3-359 close report (changed), checked against the landed file list",
    evidence: () => changedFiles(T359),
  },
  {
    id: "h-t357-checks",
    split: "heldout",
    family: "t3-357",
    stratum: "authentic",
    tags: [],
    claim:
      "Published ad11898066: context/skill ranking evaluation harness, README, 15 focused tests, one fork/hq-allowlist.json entry.",
    provenance: "T3-357 close report (changed), checked against the landed test file and file list",
    evidence: () =>
      [
        testCount(T357, `${CR}/contextRanking.test.ts`),
        changedFiles(T357)
          .split("\n")
          .filter((l) => !l.includes("results/"))
          .join("\n"),
      ].join("\n\n"),
  },
  {
    id: "h-t357-recall",
    split: "heldout",
    family: "t3-357",
    stratum: "authentic",
    tags: [],
    claim:
      "Needed-item recall at top-5 on 32 held-out cases: Jev 54/58, Luna 55/58, frozen BM25 lexical 48/58.",
    provenance: "T3-357 close report (found), checked against the retained held-out run",
    evidence: () => {
      const s = json(T357, `${CR}/results/heldout.json`).systems as Record<string, any>;
      return block(
        `read systems.<name>.rules.topK in ${CR}/results/heldout.json at ${T357.slice(0, 10)}`,
        ["lexical", "jev", "luna"]
          .map(
            (n) =>
              `${n}: ${s[n].rules.topK.neededRetained} of ${s[n].rules.topK.neededItems} needed items retained over ${s[n].rules.topK.cases} cases`,
          )
          .join("\n"),
      );
    },
  },
  {
    id: "h-t357-stale-digest",
    split: "heldout",
    family: "t3-357-stale",
    stratum: "authentic",
    tags: ["stale-revision"],
    claim:
      "failureTriage.test.ts retained-results digest is stale at head (retained failureTriage/run.ts fdd28ad2 and DecisionService.ts 60d2f7f8 vs current 5ae205ad and e63db78a).",
    provenance:
      "T3-357 close report (left), written when the head was ad11898066; evidence recomputed at the later head a09b228bdf",
    evidence: () => {
      const retained = (
        json("HEAD", `${FT}/results/heldout.json`).run as { files: Record<string, string> }
      ).files;
      const rows = [`${FT}/run.ts`, "apps/server/src/decisions/DecisionService.ts"].map((p) => {
        const key = Object.keys(retained).find(
          (k) => k.endsWith(p.split("/").slice(-2).join("/")) || k === p,
        );
        const now = sha256(NodeFS.readFileSync(NodePath.join(repoRoot, p), "utf8"));
        return `${p}: retained ${key === undefined ? "absent" : retained[key]!.slice(0, 8)}, working copy ${now.slice(0, 8)}`;
      });
      return block(
        `compare run.files in ${FT}/results/heldout.json with the sha256 of the files at ${git("rev-parse", "--short=10", "HEAD").trim()}`,
        rows.join("\n"),
      );
    },
  },
  {
    id: "h-t356-accuracy",
    split: "heldout",
    family: "t3-356",
    stratum: "authentic",
    tags: ["caveat"],
    claim:
      "Held-out n=28 (second run): accuracy vs evidence-supported label Jev 23, Luna 17, baseline 19, always-unknown 12.",
    provenance:
      "T3-356 close report (changed), checked against the retained runs at the landed commit",
    evidence: () =>
      ["results/first-run/heldout.json", "results/heldout.json"]
        .map((f) => {
          const d = json(T356, `${FT}/${f}`);
          const s = d.systems as Record<string, any>;
          return block(
            `read systems.<name>.accuracy in ${FT}/${f} at ${T356.slice(0, 10)} (runAt ${d.runAt})`,
            ["jev", "luna", "baseline", "alwaysUnknown"]
              .map((n) => `${n}: ${s[n].accuracy.numerator} of ${s[n].accuracy.denominator}`)
              .join("\n"),
          );
        })
        .join("\n\n"),
  },
  {
    id: "h-t356-cost",
    split: "heldout",
    family: "t3-356",
    stratum: "authentic",
    tags: [],
    claim:
      "Jev estimated ~$0.0014 / 28 calls, Luna ~$0.0025 (service estimates, not invoices); latency about 230-300 ms mean.",
    provenance: "T3-356 close report (changed), checked against the retained run",
    evidence: () => {
      const c = json(T356, `${FT}/results/heldout.json`).cost as Record<string, any>;
      return block(
        `read cost.<engine> in ${FT}/results/heldout.json at ${T356.slice(0, 10)}`,
        ["jev", "luna"]
          .map(
            (n) =>
              `${n}: ${c[n].calls} calls, mean latency ${c[n].latencyMs.mean.toFixed(0)} ms, cost ${c[n].costUsd.toFixed(4)} USD, status ${c[n].costStatuses.join(",")}`,
          )
          .join("\n"),
      );
    },
  },
  {
    id: "h-t357-installed",
    split: "heldout",
    family: "t3-357-install",
    stratum: "reconstructed",
    tags: ["landed-vs-installed"],
    claim: "T3-357 has landed and is installed in the app.",
    provenance:
      "claim written for this pilot; evidence is the T3-357 close report's own sentence and the landed commit",
    evidence: () =>
      [
        block("git log -1 --format='%h %s' ad11898066", git("log", "-1", "--format=%h %s", T357)),
        'T3-357 close report (left): "Retained live runs predate the upstream Crypto-to-Digest migration; run.ts, DecisionService.ts and lockfile identities differ from head, disclosed in README and pinned by a test. Not installed (no t3-fork-install), no runtime restart."',
      ].join("\n\n"),
  },
  {
    id: "h-t359-wrong-tests",
    split: "heldout",
    family: "t3-359-mutated",
    stratum: "reconstructed",
    tags: [],
    claim: "The routing pilot landed with 22 focused tests passing.",
    provenance:
      "claim written for this pilot (the report says 14); evidence from the landed test file",
    evidence: () => testCount(T359, `${AR}/autoRouting.test.ts`),
  },
  {
    id: "h-audit-nov2-passed",
    split: "heldout",
    family: "audit-nov",
    stratum: "reconstructed",
    tags: [],
    claim: "The nightly audit on 2 November passed.",
    provenance:
      "claim written for this pilot; evidence is the retained 2 November audit record (failureTriage corpus extraction)",
    evidence: () => auditFacts("2026-11-02"),
  },
  {
    id: "h-audit-oct29-count",
    split: "heldout",
    family: "audit-oct",
    stratum: "reconstructed",
    tags: [],
    claim: "Only 2 tests failed in the 29 October audit.",
    provenance: "claim written for this pilot; evidence is the retained 29 October audit record",
    evidence: () => auditFacts("2026-10-29"),
  },
  {
    id: "h-audit-nov4-not-regression",
    split: "heldout",
    family: "audit-nov4",
    stratum: "reconstructed",
    tags: ["partial-claim", "hard-negative"],
    claim: "No test failed in the 4 November audit, so the failure is not a regression.",
    provenance: "claim written for this pilot; evidence is the retained 4 November audit record",
    evidence: () => auditFacts("2026-11-04"),
  },
  {
    id: "t-t355-checks",
    split: "tune",
    family: "t3-355",
    stratum: "authentic",
    tags: [],
    claim:
      "Checks: 8 focused tests, lint and typecheck of the new files clean, runner landing gate passed.",
    provenance: "T3-355 close report (found), checked against the landed test file",
    evidence: () => testCount(T355, `${EVAL}/semanticLint/semanticLint.test.ts`),
  },
  {
    id: "t-t355-cost",
    split: "tune",
    family: "t3-355",
    stratum: "authentic",
    tags: [],
    claim:
      "Latency mean 187 ms (Jev) and 259 ms (Luna); estimated cost about $0.0006 and $0.0011 for 34 calls.",
    provenance: "T3-355 close report (found), checked against the retained run",
    evidence: () => {
      const c = json(T355, `${EVAL}/semanticLint/results/heldout.json`).cost as Record<string, any>;
      return block(
        `read cost.<engine> in semanticLint/results/heldout.json at ${T355.slice(0, 10)}`,
        ["jev", "luna"]
          .map(
            (n) =>
              `${n}: ${c[n].calls} calls, mean latency ${c[n].latencyMs.mean.toFixed(0)} ms, cost ${c[n].costUsd.toFixed(4)} USD`,
          )
          .join("\n"),
      );
    },
  },
  {
    id: "t-audit-oct26",
    split: "tune",
    family: "audit-oct26",
    stratum: "reconstructed",
    tags: [],
    claim: "All of the 26 October audit's failing tests were in test-landing.test.ts.",
    provenance: "claim written for this pilot; evidence is the retained 26 October audit record",
    evidence: () => auditFacts("2026-10-26"),
  },
];

const lineOf = (file: string, startsWith: string): string => {
  const hit = NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8")
    .split("\n")
    .find((l) => l.replace(/^[-\d.\s]*/, "").startsWith(startsWith));
  if (hit === undefined) throw new Error(`${file}: no line starting ${startsWith}`);
  return hit.replace(/^\s*(?:-|\d+\.)\s+/, "").trim();
};
const agents = (start: string) => lineOf("AGENTS.md", start);
const differences = (start: string) => lineOf("fork/differences.md", start).slice(0, 900);

const E_PROC = () => agents("**Processes:**");
const E_ORIG = () => agents("**Origins:**");
const E_MUT = () => agents("**Client mutations:**");
const E_COM = () => agents("**Comments:**");
const E_VEND = () => agents("**Vendored references:**");

interface DecisionSpec {
  id: string;
  split: "tune" | "heldout";
  family: string;
  stratum: "authentic" | "reconstructed";
  tags: string[];
  provenance: string;
  passage: () => string;
  existing: () => string[];
}

const DECISION_SPECS: DecisionSpec[] = [
  {
    id: "h-d-compaction",
    split: "heldout",
    family: "d-differences",
    stratum: "authentic",
    tags: [],
    provenance: "fork/differences.md, decision line for the projection pruning entry",
    passage: () =>
      differences(
        "**Decision:** `retain` (v0.1.8-nightly.20261104.4179, 2026-11-04): upstream's one-day",
      ),
    existing: () => [E_MUT(), E_COM()],
  },
  {
    id: "h-d-processes",
    split: "heldout",
    family: "d-agents-rules",
    stratum: "authentic",
    tags: [],
    provenance: "AGENTS.md, runtime safety rule 1",
    passage: E_PROC,
    existing: () => [E_COM(), E_VEND()],
  },
  {
    id: "h-d-origins",
    split: "heldout",
    family: "d-agents-rules",
    stratum: "authentic",
    tags: [],
    provenance: "AGENTS.md, runtime safety rule 3",
    passage: E_ORIG,
    existing: () => [E_MUT(), E_VEND()],
  },
  {
    id: "h-d-chat-tables",
    split: "heldout",
    family: "d-differences",
    stratum: "authentic",
    tags: [],
    provenance: "fork/differences.md, decision line for the chat table alignment entry",
    passage: () =>
      differences(
        "**Decision:** `adapt` (v0.1.3-nightly.20261025.3669, 2026-10-25): upstream aligns chat tables",
      ),
    existing: () => [E_MUT(), E_COM()],
  },
  {
    id: "h-d-highlights",
    split: "heldout",
    family: "d-differences",
    stratum: "authentic",
    tags: [],
    provenance: "fork/differences.md, decision line for the code highlighting entry",
    passage: () =>
      differences(
        "**Decision:** `adapt` (v0.1.3-nightly.20261025.3655, 2026-10-25): upstream replaced Shiki",
      ),
    existing: () => [E_COM(), E_VEND()],
  },
  {
    id: "h-d-usage-padding",
    split: "heldout",
    family: "d-commits",
    stratum: "authentic",
    tags: [],
    provenance: "git commit 3368dd70f2 message",
    passage: () => git("log", "-1", "--format=%B", "3368dd70f2").trim(),
    existing: () => [E_MUT(), E_ORIG()],
  },
  {
    id: "h-d-next-step",
    split: "heldout",
    family: "d-reports",
    stratum: "authentic",
    tags: ["agreed-vs-suggested"],
    provenance: "T3-359 close report (left)",
    passage: () =>
      "Nothing is enabled: any production routing needs the parent's decision on this evidence. Recommended next step if pursued: shadow-only subagent-tier recommendation with demanding on every abstention, recording real outcome and cost of each routed task; project routing via deterministic rules (stated project, workspace repository), not a classifier; the workflow fallback must not be solo for work that reads as large.",
    existing: () => [E_COM()],
  },
  {
    id: "h-d-follow-up",
    split: "heldout",
    family: "d-reports",
    stratum: "authentic",
    tags: ["agreed-vs-suggested"],
    provenance: "T3-355 close report (left)",
    passage: () =>
      "Possible follow-up: a second pilot on sanitized real repository diffs with harder negatives, labelled before any model call, with human adjudication of disputed cases. Nothing changed in production lints, defaults or UI; no installed-runtime rebuild was needed.",
    existing: () => [E_VEND()],
  },
  {
    id: "h-d-invariant",
    split: "heldout",
    family: "d-reports",
    stratum: "authentic",
    tags: [],
    provenance: "T3-355 close report (changed)",
    passage: () =>
      "Invariant: failures, refusals and unknowns count as not flagged and are reported separately.",
    existing: () => [E_COM()],
  },
  {
    id: "h-d-restated-processes",
    split: "heldout",
    family: "d-restated",
    stratum: "reconstructed",
    tags: ["duplicate"],
    provenance:
      "passage written for this pilot as a lead might report it; existing decision is the verbatim AGENTS.md rule",
    passage: () =>
      "For this run I will stop only the process whose PID I captured when I spawned it, and I will not kill anything found by matching a name or path.",
    existing: () => [E_PROC(), E_COM()],
  },
  {
    id: "h-d-restated-origins",
    split: "heldout",
    family: "d-restated",
    stratum: "reconstructed",
    tags: ["duplicate"],
    provenance: "passage written for this pilot; existing decision is the verbatim AGENTS.md rule",
    passage: () =>
      "Decision: dev traffic stays on the browser's own origin through the Vite proxy, so VITE_HTTP_URL and VITE_WS_URL stay unset; a baked-in localhost would break remote clients.",
    existing: () => [E_ORIG(), E_MUT()],
  },
  {
    id: "t-d-upstream-policy",
    split: "tune",
    family: "t-fork-policy",
    stratum: "authentic",
    tags: [],
    provenance: "fork/README.md upstream policy 2",
    passage: () => lineOf("fork/README.md", "When upstream covers part of a capability"),
    existing: () => [E_COM()],
  },
  {
    id: "t-d-adopt-force-kill",
    split: "tune",
    family: "t-differences",
    stratum: "authentic",
    tags: [],
    provenance: "fork/differences.md, decision line for the ACP terminal entry",
    passage: () =>
      differences(
        "**Decision:** `adopt` (v0.1.3-nightly.20261025.3655, 2026-10-25): upstream force-kills",
      ),
    existing: () => [E_VEND()],
  },
];

const out = [
  ...SPECS.map((s) => ({ kind: "claim" as const, ...s, evidence: s.evidence() })),
  ...DECISION_SPECS.map(({ passage, existing, ...s }) => ({
    kind: "decision" as const,
    ...s,
    passage: passage(),
    existing: existing(),
  })),
];
NodeFS.writeFileSync(
  NodePath.join(here, "corpusAuthentic.json"),
  `${JSON.stringify(out, null, 2)}\n`,
);
console.log(`wrote ${out.length} cases`);
