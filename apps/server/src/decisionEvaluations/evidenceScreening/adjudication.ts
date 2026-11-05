// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - offline scorer for the bounded adjudication check
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { HELDOUT_CASES } from "./corpusHeldout.ts";
import { labelId } from "./labelPacket.ts";
import heldout from "./results/heldout.json" with { type: "json" };

interface Reply {
  readonly label: string;
  readonly reason: string;
}

/** Joins the adjudicator's reply (blind to every engine flag and label) to the engines' escalations and the labelers' agreed labels. Records nothing. */
export const scoreReply = (reply: Record<string, Reply>, replySha256: string) => {
  const cases = HELDOUT_CASES.filter((c) => c.kind === "decision");
  const rows = cases.map((c) => {
    const verdict = heldout.verdicts[c.id as keyof typeof heldout.verdicts] as unknown as Record<
      string,
      { flagged: boolean }
    >;
    const audit = heldout.labelAudit.find((a) => a.caseId === c.id)!;
    const r = reply[labelId(c.id)];
    if (r === undefined) throw new Error(`No adjudication for ${c.id}`);
    return {
      caseId: c.id,
      adjudicator: r.label,
      reason: r.reason,
      referenceLabel: audit.agreed,
      escalated: {
        jev: verdict.jev!.flagged,
        luna: verdict.luna!.flagged,
        baseline: verdict.baseline!.flagged,
      },
    };
  });
  const per = (system: "jev" | "luna" | "baseline") => {
    const escalated = rows.filter((r) => r.escalated[system]);
    return {
      escalated: escalated.length,
      adjudicatorWouldRecord: escalated.filter((r) => r.adjudicator === "record").length,
      adjudicatorDeclined: escalated.filter((r) => r.adjudicator === "do-not-record").length,
      adjudicatorNeedsHuman: escalated.filter((r) => r.adjudicator === "needs-human").length,
      recordedButNotEscalated: rows
        .filter((r) => !r.escalated[system] && r.adjudicator === "record")
        .map((r) => r.caseId),
    };
  };
  return {
    schema: "evidence-screening-adjudication-v1",
    replySha256,
    heldoutCorpusDigest: heldout.corpusDigest,
    adjudicatorWouldRecord: rows.filter((r) => r.adjudicator === "record").length,
    systems: { jev: per("jev"), luna: per("luna"), baseline: per("baseline") },
    rows,
  };
};

export const scoreAdjudication = (replyPath: string) => {
  const text = NodeFS.readFileSync(replyPath, "utf8");
  return scoreReply(
    JSON.parse(text) as Record<string, Reply>,
    NodeCrypto.createHash("sha256").update(text).digest("hex"),
  );
};

if (import.meta.main) {
  const [replyPath, out] = process.argv.slice(2);
  const scored = scoreAdjudication(replyPath!);
  NodeFS.writeFileSync(out!, `${JSON.stringify(scored, null, 2)}\n`);
  console.log(JSON.stringify({ ...scored, rows: undefined }, null, 2));
}
