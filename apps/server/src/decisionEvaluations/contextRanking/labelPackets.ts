// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - offline helper that writes labeler packets, run by hand
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { orderedCandidates, POOL_BY_ID } from "./caseBuilder.ts";
import { HELDOUT_CASES } from "./corpusHeldout.ts";
import { TUNE_CASES } from "./corpusTune.ts";

/** Writes the packets labelers read: the task, the mandatory and requested context, and the shuffled candidates. Nothing about expectations or systems. */
const out = process.argv[2];
if (out === undefined) throw new Error("usage: labelPackets.ts <output directory>");
NodeFS.mkdirSync(out, { recursive: true });
const all = [...TUNE_CASES, ...HELDOUT_CASES];
const view = (id: string) => {
  const i = POOL_BY_ID.get(id)!;
  return { id, kind: i.kind, title: i.title, description: i.description, bodyBytes: i.bodyBytes };
};
const BATCH = 10;
for (let b = 0; b * BATCH < all.length; b++) {
  const cases = all.slice(b * BATCH, (b + 1) * BATCH).map((c) => ({
    caseId: c.id,
    task: c.task,
    alreadyIncludedGoverning: c.mandatory.map(view),
    alreadyIncludedRequestedSkills: c.requested.map(view),
    candidates: orderedCandidates(c).map(({ ref, id }) => ({ ref, ...view(id) })),
  }));
  NodeFS.writeFileSync(
    NodePath.join(out, `packet-${b + 1}.json`),
    `${JSON.stringify(cases, null, 2)}\n`,
  );
}
console.log(`${all.length} cases in ${Math.ceil(all.length / BATCH)} packets`);
