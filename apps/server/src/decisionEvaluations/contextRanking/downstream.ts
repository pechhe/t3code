// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - offline helper for the bounded downstream-answer check, run by hand
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { lexicalScores } from "./baseline.ts";
import { orderedCandidates, POOL_BY_ID, shuffled } from "./caseBuilder.ts";
import { HELDOUT_CASES } from "./corpusHeldout.ts";
import type { RankingCase } from "./corpusTypes.ts";
import { select, type CaseView } from "./scoring.ts";

/**
 * The downstream check: does the answer to a task get worse when an agent is given a smaller, ranked context instead of every candidate?
 * Cases, questions and rubrics were fixed before the held-out run. Arms are the full candidate set, the lexical top-5 and the Jev top-5.
 * Each answer comes from a fresh managed worker told to use only the supplied text; a different, blinded grader scores it against the rubric.
 */
export const DOWNSTREAM: ReadonlyArray<{
  caseId: string;
  question: string;
  rubric: ReadonlyArray<string>;
}> = [
  {
    caseId: "h-cost-aggregation",
    question:
      "How should my evaluation summary treat the spend and tokens of model calls that failed and returned no usage, and what should it still report?",
    rubric: [
      "Failed or unobserved calls have unknown spend, not zero.",
      "A total that includes an unobserved call stays unknown.",
      "The known part is reported separately.",
    ],
  },
  {
    caseId: "h-write-recommendation",
    question:
      "What does a thirty-case pilot on a corpus I wrote myself support, and how should I report it?",
    rubric: [
      "No significance claim: with about thirty cases the intervals overlap, so report counts with intervals.",
      "A single-author regular synthetic corpus supports revise at most, not adopt.",
      "Report results under each labeler alone as well as the adjudicated labels.",
    ],
  },
  {
    caseId: "h-flaky-econnreset",
    question: "Should we put this test in the flake registry and quarantine it?",
    rubric: [
      "Do not quarantine or dismiss on the symptom alone; investigate.",
      "A registered flaky test that fails with a different error than its registered signature is not a known flake.",
      "Read the change under test before blaming the environment, since an environment-looking failure can be caused by the change.",
    ],
  },
  {
    caseId: "h-rate-limited-run",
    question: "What limits must the run respect and how should it treat a failed call?",
    rubric: [
      "The service admits 60 calls per minute.",
      "At most 4 calls at once.",
      "Use a fixed gap between calls and do not retry automatically.",
      "A failed call is still recorded.",
    ],
  },
  {
    caseId: "h-single-label",
    question:
      "Why is my choice question with one allowed label rejected, and what should I change?",
    rubric: [
      "A choice question needs at least two labels.",
      "The foundation rejects a single-option question before encoding.",
      "Add a second option, or use a predicate question instead.",
    ],
  },
  {
    caseId: "h-dev-pairing",
    question:
      "How do I get browser pairing working against copied test data without touching my running installation?",
    rubric: [
      "Never open ~/.t3/userdata read-write or start a server on it; copy from it into an isolated home.",
      "Do not set VITE_HTTP_URL or VITE_WS_URL in dev; Vite proxies through the browser origin.",
      "Follow the isolated-home, setup-marker and pairing steps in the development guide.",
    ],
  },
];

export const ARMS = ["all", "lexical", "jev"] as const;
export type Arm = (typeof ARMS)[number];
/** Characters of a file or skill body shown in the check; a finding is shown whole. */
const BODY_CHARS = 2000;

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repoRoot = NodePath.resolve(here, "../../../../..");

/** Reads a pool file's text; the default is the working tree, as a live run sees it. */
export type ContextReader = (path: string) => string;

const readFromTree: ContextReader = (path) => NodeFS.readFileSync(path, "utf8");

const bodyOf = (
  id: string,
  limit: number = BODY_CHARS,
  read: ContextReader = readFromTree,
): string => {
  const item = POOL_BY_ID.get(id)!;
  if (item.kind === "finding") return item.description;
  const path = id.startsWith("skill:")
    ? [
        NodePath.join(NodeOS.homedir(), ".agents/skills", id.slice(6), "SKILL.md"),
        NodePath.join(repoRoot, ".agents/skills", id.slice(6), "SKILL.md"),
      ].find((p) => NodeFS.existsSync(p))!
    : NodePath.join(repoRoot, id.slice(5));
  return read(path).slice(0, limit);
};

export const contextText = (
  ids: ReadonlyArray<string>,
  seed: string,
  read?: ContextReader,
): string =>
  shuffled(ids, `ctx:${seed}`)
    .map((id) => `### ${POOL_BY_ID.get(id)!.title}\n${bodyOf(id, BODY_CHARS, read)}`)
    .join("\n\n");

/** Governing and requested context goes to every arm whole: it sits outside ranking and outside the truncation of candidate bodies. */
export const fixedContextText = (c: RankingCase, read?: ContextReader): string =>
  [...c.mandatory, ...c.requested]
    .map((id) => `### ${POOL_BY_ID.get(id)!.title}\n${bodyOf(id, Number.POSITIVE_INFINITY, read)}`)
    .join("\n\n");

export const armContext = (
  c: RankingCase,
  ids: ReadonlyArray<string>,
  arm: Arm,
  read?: ContextReader,
): string =>
  [fixedContextText(c, read), contextText(ids, `${c.id}:${arm}`, read)]
    .filter((x) => x !== "")
    .join("\n\n");

interface Retained {
  records: ReadonlyArray<{
    caseId: string;
    engine: string;
    outcome: { kind: string; scores?: Record<string, number | null> };
  }>;
}

const viewOf = (c: RankingCase, scores: (ref: string) => number | null): CaseView => ({
  caseId: c.id,
  stratum: c.stratum,
  fixedTokens: 0,
  candidates: orderedCandidates(c).map(({ ref, id }) => ({
    id,
    ref,
    tokens: 0,
    reference: "uncertain",
    score: scores(ref),
  })),
});

/** Which candidates each arm hands the answerer, from the retained held-out run. */
export const armSelections = (
  retained: Retained,
  c: RankingCase,
): Record<Arm, ReadonlyArray<string>> => {
  const lex = lexicalScores(c);
  const record = retained.records.find((r) => r.caseId === c.id && r.engine === "jev");
  const jev = record?.outcome.kind === "answered" ? record.outcome.scores! : {};
  return {
    all: c.candidates,
    lexical: [
      ...select(
        viewOf(c, (ref) => lex[ref] ?? null),
        "topK",
      ),
    ],
    jev: [
      ...select(
        viewOf(c, (ref) => jev[ref] ?? null),
        "topK",
      ),
    ],
  };
};

if (
  process.argv[1] !== undefined &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1]) &&
  process.argv[2] === "prepare"
) {
  const [command, heldoutPath, outDir] = process.argv.slice(2);
  if (command !== "prepare" || heldoutPath === undefined || outDir === undefined)
    throw new Error("usage: downstream.ts prepare <heldout.json> <output directory>");
  const retained = JSON.parse(NodeFS.readFileSync(heldoutPath, "utf8")) as Retained;
  NodeFS.mkdirSync(outDir, { recursive: true });
  const manifest: Array<{
    key: string;
    caseId: string;
    arm: Arm;
    items: ReadonlyArray<string>;
    contextChars: number;
  }> = [];
  for (const d of DOWNSTREAM) {
    const c = HELDOUT_CASES.find((x) => x.id === d.caseId)!;
    const selections = armSelections(retained, c);
    for (const arm of ARMS) {
      const key = `a${manifest.length + 1}`;
      const context = armContext(c, selections[arm], arm);
      NodeFS.writeFileSync(
        NodePath.join(outDir, `${key}.txt`),
        `You are answering a question for an engineer. Use ONLY the context below. Do not read files, run commands or use any tool; if the context does not contain what you need, say so.\n\nTask: ${c.task}\n\nQuestion: ${d.question}\n\nContext:\n\n${context}\n\nAnswer in under 150 words.\n`,
      );
      manifest.push({
        key,
        caseId: c.id,
        arm,
        items: selections[arm],
        contextChars: context.length,
      });
    }
  }
  NodeFS.writeFileSync(
    NodePath.join(outDir, "manifest.private.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(`${manifest.length} prompts in ${outDir}`);
}

if (
  process.argv[1] !== undefined &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1]) &&
  process.argv[2] === "score"
) {
  const [, promptDir, gradeDir, gradesPath, out] = process.argv.slice(2);
  if (
    promptDir === undefined ||
    gradeDir === undefined ||
    gradesPath === undefined ||
    out === undefined
  )
    throw new Error(
      "usage: downstream.ts score <prompt dir> <grade dir> <grades.json> <output.json>",
    );
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(promptDir, "manifest.private.json"), "utf8"),
  ) as Array<{ key: string; caseId: string; arm: Arm; items: string[]; contextChars: number }>;
  const map = JSON.parse(
    NodeFS.readFileSync(NodePath.join(gradeDir, "map.private.json"), "utf8"),
  ) as Record<string, string>;
  const grades = JSON.parse(NodeFS.readFileSync(gradesPath, "utf8")) as Record<string, number[]>;
  const rows = Object.entries(map).map(([g, key]) => {
    const m = manifest.find((x) => x.key === key)!;
    const d = DOWNSTREAM.find((x) => x.caseId === m.caseId)!;
    const marks = grades[g]!;
    if (marks.length !== d.rubric.length)
      throw new Error(`${g}: ${marks.length} marks for ${d.rubric.length} rubric lines`);
    const answerPath = NodePath.join(NodePath.dirname(gradesPath), "answers", `${key}.txt`);
    return {
      caseId: m.caseId,
      arm: m.arm,
      items: m.items,
      contextChars: m.contextChars,
      marks,
      met: marks.reduce((a, b) => a + b, 0),
      of: marks.length,
      answer: NodeFS.existsSync(answerPath) ? NodeFS.readFileSync(answerPath, "utf8").trim() : null,
    };
  });
  const arms = Object.fromEntries(
    ARMS.map((arm) => {
      const own = rows.filter((r) => r.arm === arm);
      return [
        arm,
        {
          cases: own.length,
          met: own.reduce((n, r) => n + r.met, 0),
          of: own.reduce((n, r) => n + r.of, 0),
          fullMarkCases: own.filter((r) => r.met === r.of).length,
          meanContextChars: own.reduce((n, r) => n + r.contextChars, 0) / own.length,
        },
      ];
    }),
  );
  NodeFS.writeFileSync(
    out,
    `${JSON.stringify({ schema: "context-ranking-downstream-v1", bodyChars: BODY_CHARS, rubric: DOWNSTREAM, arms, rows }, null, 2)}\n`,
  );
  console.log(JSON.stringify(arms, null, 2));
}
