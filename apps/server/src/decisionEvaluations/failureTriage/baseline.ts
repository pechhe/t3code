import type { TriageCase, TriageEvidence, TriageLabel } from "./corpusTypes.ts";

export const BASELINE_VERSION = "exit-signature-v1";

const ENVIRONMENT_SIGNATURE =
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOSPC|ENOMEM|ERR_PNPM_FETCH_5\d\d|Service Unavailable|Bad Gateway|No space left|\bKilled\b|exit 137|out of memory/i;
const FIXTURE_SIGNATURE =
  /ENOENT[^\n]*fixture|obsolete snapshot|toMatchSnapshot|Snapshot .* mismatched/i;
const TYPECHECK_SIGNATURE = /error TS\d+/;

const stems = (text: string): Set<string> =>
  new Set(
    [...text.matchAll(/([A-Za-z0-9_-]+)\.(?:[a-z]+\.)*(?:ts|tsx|js|json|md)\b/g)].map((m) => m[1]!),
  );

const registryHit = (e: TriageEvidence): boolean =>
  Array.isArray(e.knownFlakeRegistry) &&
  e.failingTests.some((t) =>
    (e.knownFlakeRegistry as ReadonlyArray<string>).some((r) => r.startsWith(t)),
  );

/**
 * Fixed before any held-out call, in this order: bare exit, environment signature, registry hit, type error,
 * a failing file whose stem matches a changed file, fixture signature, otherwise unknown. It never reads history or the change description.
 */
export const baselineLabel = (c: TriageCase): TriageLabel => {
  const e = c.evidence;
  if (e.failingTests.length === 0 && e.firstError.trim() === "") return "unknown";
  const text = `${e.check}\n${e.failingTests.join("\n")}\n${e.firstError}\n${e.outputTail}`;
  if (ENVIRONMENT_SIGNATURE.test(text) || ENVIRONMENT_SIGNATURE.test(e.exitStatus))
    return "environment";
  if (registryHit(e)) return "known-flake";
  if (TYPECHECK_SIGNATURE.test(e.firstError)) return "regression";
  const failing = stems(`${e.check}\n${e.failingTests.join("\n")}\n${e.firstError}`);
  const changed = new Set((e.changedFiles ?? []).flatMap((f) => [...stems(f)]));
  if ([...failing].some((s) => changed.has(s))) return "regression";
  if (FIXTURE_SIGNATURE.test(text)) return "fixture";
  return "unknown";
};
