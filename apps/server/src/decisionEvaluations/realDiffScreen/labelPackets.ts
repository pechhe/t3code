// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - one-off packet writer, not server code
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { diffEvidence, sha256, type Repo } from "./diffs.ts";

/**
 * Writes one blind packet file per item for the two labelers: defects and clean candidates mixed and shuffled, named
 * only by an opaque id. Usage: node labelPackets.ts <outDir> <items.json> where items.json is
 * [{ ref: "repo:commit" }]. Writes <outDir>/<id>.md and <outDir>/key.json (id -> ref, digest).
 */
const [outDir, itemsFile] = process.argv.slice(2);
if (outDir === undefined || itemsFile === undefined)
  throw new Error("usage: labelPackets.ts <outDir> <items.json>");
const refs = JSON.parse(NodeFS.readFileSync(itemsFile, "utf8")) as string[];
NodeFS.mkdirSync(outDir, { recursive: true });
const key: Record<
  string,
  { ref: string; digest: string; truncated: boolean; changedLines: number }
> = {};
refs.forEach((ref, i) => {
  const [repo, commit] = ref.split(":") as [Repo, string];
  const e = diffEvidence(repo, commit);
  const id = `L${String(i + 1).padStart(3, "0")}`;
  key[id] = { ref, digest: sha256(e.text), truncated: e.truncated, changedLines: e.changedLines };
  NodeFS.writeFileSync(
    NodePath.join(outDir, `${id}.md`),
    `# ${id}\n\n\`\`\`diff\n${e.text}\n\`\`\`\n`,
  );
});
NodeFS.writeFileSync(NodePath.join(outDir, "key.json"), JSON.stringify(key, null, 1));
console.log(`wrote ${refs.length} packets`);
