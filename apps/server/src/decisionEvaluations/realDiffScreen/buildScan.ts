// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - one-off scan, not server code
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { CaseRecord } from "./corpus.ts";
import { evidenceOf } from "./corpus.ts";

/** Pattern scan over the evidence of every case; a hit is read by a person before the case stays. Usage: node buildScan.ts */
const PATTERNS: Record<string, RegExp> = {
  email: /[\w.+-]+@[\w-]+\.[\w.-]+/,
  privateKey: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  longToken: /\b(?:sk|pk|ghp|gho|xox[bp]|AKIA|AIza)[-_A-Za-z0-9]{16,}\b/,
  bearer: /bearer\s+[A-Za-z0-9._-]{20,}/i,
  assignedSecret: /(?:password|secret|token|api[_-]?key)\s*[:=]\s*["'][^"'\s]{12,}["']/i,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  owner: /\bHenry\b|\bPetch\b/i,
};
const cases = JSON.parse(
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "corpus/cases.json"), "utf8"),
) as CaseRecord[];
const hits: { id: string; pattern: string; sample: string }[] = [];
for (const c of cases) {
  const text = evidenceOf(c);
  for (const [pattern, re] of Object.entries(PATTERNS)) {
    const m = re.exec(text);
    if (m !== null) hits.push({ id: c.id, pattern, sample: m[0].slice(0, 60) });
  }
}
console.log(JSON.stringify(hits, null, 1));
