// @effect-diagnostics nodeBuiltinImport:off - Reads the kernel's view of Chrome's processes from /proc.
import type {
  ChampionJourney,
  ChampionJourneyManifest,
  ChampionJourneyStep,
} from "@t3tools/contracts";
import * as NodeFS from "node:fs";

/** The workId prefix of a replay, which keeps it apart from a repair's or an investigation's. */
export const CANDIDATE_WORK_PREFIX = "champion-candidate:";
export const isCandidateWorkId = (workId: string | undefined) =>
  workId?.startsWith(CANDIDATE_WORK_PREFIX) === true;

/** The most intervals open at one instant. An interval still running counts until `now`. */
export const peakConcurrency = (
  intervals: ReadonlyArray<{ readonly startedAt: string; readonly endedAt: string | null }>,
  now: number,
) => {
  const edges = intervals.flatMap(({ startedAt, endedAt }) => [
    [Date.parse(startedAt), 1] as const,
    [endedAt === null ? now : Date.parse(endedAt), -1] as const,
  ]);
  // At the same instant a journey that ends is not overlapping the one that starts.
  edges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let open = 0;
  let peak = 0;
  for (const [, change] of edges) {
    open += change;
    peak = Math.max(peak, open);
  }
  return peak;
};

export const percentile = (values: ReadonlyArray<number>, fraction: number): number | null => {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
};

/** Reasons a journey ended because of a limit we set, not because of the app. */
const LIMIT_REASONS = new Set([
  "decision-limit",
  "action-limit",
  "deadline",
  "decision-busy",
  "decision-rate-limited",
]);
export const isLimitStop = (reason: string | null | undefined) =>
  reason !== null && reason !== undefined && LIMIT_REASONS.has(reason);

/** The machine or a shared allowance ran short. A journey spending its own budget says nothing of capacity. */
const CAPACITY_REASONS = new Set(["deadline", "decision-busy", "decision-rate-limited"]);
export const isCapacityStop = (reason: string | null | undefined) =>
  reason !== null && reason !== undefined && CAPACITY_REASONS.has(reason);

/** A task's status, as a journey's outcome: a page that failed its checks is a failure, a run cut short is not. */
export const journeyOutcome = (
  status: "running" | "passed" | "failed" | "blocked" | "cancelled",
): ChampionJourney["outcome"] =>
  status === "running"
    ? "running"
    : status === "passed"
      ? "passed"
      : status === "failed"
        ? "failed"
        : "stopped";

/** Credential names a target's server may not hold: anything that could reach a real person or outside service. */
const CREDENTIAL_NAME =
  /(API_?KEY|API_?TOKEN|_TOKEN$|_SECRET$|ACCESS_?KEY|LIVEKIT|OPENAI|ANTHROPIC|OPENROUTER|CARTESIA|ABLY|GMAIL|GOOGLE_CLIENT|STRIPE|TRUELAYER|TWILIO|SMTP|SENDGRID|RESEND|POSTMARK|S3_|OPTIMIZER)/i;
/** What a shard must hold to be itself. Its auth secret is its own, made for it, and acts on nothing outside. */
const SHARD_OWN_SECRETS = new Set(["BETTER_AUTH_SECRET"]);

export interface InspectedContainer {
  readonly name: string;
  readonly running: boolean;
  readonly environmentNames: ReadonlyArray<string>;
  readonly databaseName: string | null;
  readonly networks: ReadonlyArray<{ readonly name: string; readonly internal: boolean }>;
}

/** Why a target must not be attacked, or null. Decided from the manifest and what Docker reports about each shard. */
export const targetRefusal = (
  manifest: ChampionJourneyManifest,
  containers: ReadonlyArray<InspectedContainer>,
): string | null => {
  if (manifest.synthetic !== true) return "The target does not declare synthetic data.";
  for (const shard of manifest.shards) {
    let origin: URL;
    try {
      origin = new URL(shard.origin);
    } catch {
      return `Shard ${shard.id} has no usable origin.`;
    }
    if (origin.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(origin.hostname))
      return `Shard ${shard.id} is at ${shard.origin}, which is not this machine's loopback.`;
    if (!/^scratch_[0-9a-f]{8}$/.test(shard.database))
      return `Shard ${shard.id} uses database ${shard.database}, which is not a disposable synthetic clone.`;
    const container = containers.find((candidate) => candidate.name === shard.container);
    if (container === undefined || !container.running)
      return `Shard ${shard.id}'s container ${shard.container} is not running.`;
    if (container.networks.length === 0 || container.networks.some((network) => !network.internal))
      return `Shard ${shard.id} can reach a network with a route out (${container.networks.map((network) => network.name).join(", ") || "none"}).`;
    if (container.databaseName !== shard.database)
      return `Shard ${shard.id}'s server is connected to ${container.databaseName ?? "no database"}, not ${shard.database}.`;
    const credentials = container.environmentNames.filter(
      (name) => CREDENTIAL_NAME.test(name) && !SHARD_OWN_SECRETS.has(name),
    );
    if (credentials.length > 0)
      return `Shard ${shard.id}'s server holds credentials: ${credentials.join(", ")}.`;
  }
  const seen = new Set(manifest.shards.map((shard) => shard.database));
  if (seen.size !== manifest.shards.length) return "Two shards share one database.";
  return null;
};

/** The `host:port` entries a target's browsers may reach: its own shards and nothing else. */
export const allowlistOf = (manifest: ChampionJourneyManifest) =>
  manifest.shards.flatMap((shard) => {
    const origin = new URL(shard.origin);
    return [`localhost:${origin.port}`, `127.0.0.1:${origin.port}`];
  });

/** Why the server cannot call this check complete, whatever its owner reported; null when it can. */
export const incompleteReason = (input: {
  readonly served: {
    readonly started: number;
    readonly passed: number;
    readonly failed: number;
    readonly stopped: number;
    readonly running: number;
  };
  readonly owner:
    | {
        readonly started: number;
        readonly passed: number;
        readonly failed: number;
        readonly stopped: number;
      }
    | undefined;
  readonly journeyLimit: number;
  readonly downShards: ReadonlyArray<string>;
  readonly pendingCandidates: number;
  readonly capture: { readonly outside: ReadonlyArray<unknown> } | null;
}) => {
  const { served, owner } = input;
  if (input.downShards.length > 0)
    return `Shard${input.downShards.length === 1 ? "" : "s"} ${input.downShards.join(", ")} stopped answering during the check.`;
  if (input.capture === null) return "The target's network capture could not be read.";
  if (input.capture.outside.length > 0)
    return `The target's network carried traffic to ${input.capture.outside.length} outside addresses.`;
  if (served.running > 0) return `${served.running} journeys never finished.`;
  if (served.started === 0) return "No journey ran.";
  if (input.pendingCandidates > 0)
    return `${input.pendingCandidates} failing journeys were never confirmed or rejected.`;
  if (owner === undefined) return "The owner gave no account of its journeys.";
  if (
    owner.started !== served.started ||
    owner.passed !== served.passed ||
    owner.failed !== served.failed ||
    owner.stopped !== served.stopped
  )
    return `The owner reported ${owner.started} started, ${owner.passed} passed, ${owner.failed} failed, ${owner.stopped} stopped; the server recorded ${served.started}, ${served.passed}, ${served.failed}, ${served.stopped}.`;
  return null;
};

/** A run below its planned overlap says so, since that overlap is what a check is measured on. */
export const narrowRunReason = (reached: number, planned: number) =>
  reached > 0 && reached < planned
    ? `Journeys ran at most ${reached} at once of the ${planned} planned.`
    : null;

/** A path without its origin, so steps stay true on the fresh shard a replay runs on. */
const pathOf = (url: string | null) => {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
};

/** One recorded step in plain words. */
export const describeStep = (step: ChampionJourneyStep) => {
  const element =
    step.target === null
      ? (step.description ?? step.id)
      : `the ${step.target.role} named "${step.target.name}"`;
  const action =
    step.operation === "type"
      ? `type ${JSON.stringify(step.value ?? "")} into ${element}`
      : step.operation === "select"
        ? `choose ${JSON.stringify(step.option ?? "")} in ${element}`
        : step.operation === "navigate"
          ? `go to ${element}`
          : `${step.operation} ${element}`;
  const path = pathOf(step.url);
  return path === null ? action : `On ${path}: ${action}`;
};

export const describeSteps = (steps: ReadonlyArray<ChampionJourneyStep>) => {
  const runs: Array<{ text: string; times: number }> = [];
  for (const step of steps) {
    const text = describeStep(step);
    const last = runs.at(-1);
    if (last?.text === text) last.times += 1;
    else runs.push({ text, times: 1 });
  }
  return runs
    .map(
      ({ text, times }, index) =>
        `${index + 1}. ${text}${times === 1 ? "" : ` (repeated ${times} times)`}`,
    )
    .join("\n");
};

const pageOf = (url: string | null) => {
  if (url === null) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

/** One bug's journeys end the same way: the same last step on the same page, reaching the same page. */
const pagesOf = (steps: ReadonlyArray<ChampionJourneyStep>) =>
  [...new Set(steps.map((step) => pageOf(step.url)))].sort().join(" ");

// Joining only repeats: two routes to one last click can be two bugs, and a merge would hide one.
export const sameFailure = (
  a: { readonly steps: ReadonlyArray<ChampionJourneyStep>; readonly finalUrl: string | null },
  b: { readonly steps: ReadonlyArray<ChampionJourneyStep>; readonly finalUrl: string | null },
) => {
  const last = a.steps.at(-1);
  const other = b.steps.at(-1);
  return (
    last !== undefined &&
    other !== undefined &&
    pageOf(a.finalUrl) === pageOf(b.finalUrl) &&
    pageOf(last.url) === pageOf(other.url) &&
    pagesOf(a.steps) === pagesOf(b.steps) &&
    last.operation === other.operation &&
    last.target?.role === other.target?.role &&
    last.target?.name === other.target?.name
  );
};

/** Which paths a journey walked, for coverage and to tell one bug's failure from another's. */
export const urlsOf = (steps: ReadonlyArray<ChampionJourneyStep>) => [
  ...new Set(steps.flatMap((step) => pathOf(step.url) ?? [])),
];

const FINDING_EVIDENCE_LIMIT = 8000;
const cut = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 7))}\n[cut]`;

/** A finding's stored evidence has a limit; what was seen and who confirmed it are kept whole first. */
export const findingEvidence = (input: {
  readonly observed: string;
  readonly expected: string;
  readonly commit: string;
  readonly steps: string;
  readonly clicks: string;
  readonly model: string;
  readonly reason: string;
  readonly screenshot: string;
}) => {
  const seen = cut(`${input.observed} Expected: ${input.expected}`, 2000);
  const confirmed = cut(`Confirmed in isolation by ${input.model}: ${input.reason}`, 1500);
  const shot = `Screenshot: ${input.screenshot}`;
  const stepsLabel = `Steps to reproduce, on a fresh copy of the seeded data (build ${input.commit}):\n`;
  const clicksLabel = "Recorded clicks: ";
  const room =
    FINDING_EVIDENCE_LIMIT -
    [seen, confirmed, shot, stepsLabel, clicksLabel].join("").length -
    4 * 2;
  const steps = cut(input.steps, Math.floor(room / 2));
  return [
    seen,
    `${stepsLabel}${steps}`,
    `${clicksLabel}${cut(input.clicks, room - steps.length)}`,
    confirmed,
    shot,
  ].join("\n\n");
};

export const VERDICT_FORMAT = `End your final message with exactly these lines:
VERDICT: reproduced | not-reproduced | blocked
REASON: <one sentence: what you saw>
SCREENSHOT: <the screenshotPath of the page that shows it>`;

export const replayBrief = (input: {
  readonly title: string;
  readonly expected: string;
  readonly observed: string;
  readonly origin: string;
  readonly signInPath: string;
  readonly steps: ReadonlyArray<ChampionJourneyStep>;
  readonly finalUrl: string | null;
  readonly retest: boolean;
}) => `An earlier browser journey may have found a bug. Decide whether it reproduces. You are the only judge: the journey's own model never judges correctness.

You are on a freshly seeded database that no other journey has touched, so anything that depended on shared data will not recur. Do not read source. Use only the integrated browser, and only ${input.origin}.

Reported failure: ${input.title}
Expected: ${input.expected}
Observed: ${input.observed}

Sign in by opening ${input.origin}${input.signInPath}, then follow these recorded steps in order. Paths are relative to ${input.origin}. Where a name differs slightly because this database is fresh, use the closest match and say so.
${describeSteps(input.steps)}
${input.finalUrl === null ? "" : `The journey ended on ${pathOf(input.finalUrl)}.\n`}
Say "reproduced" only if you saw the observed failure yourself and a real person would call it broken: an error, a dead end, or work lost. The report's expectation may itself be wrong: an empty state on a fresh database, a nicety the page does not offer, or a feature failing because this contained copy has no real model, voice or outbound service, is not a bug, so say "not-reproduced" for those, as you do when you carried out every step and the expected behaviour happened. If a step's target does not exist on this fresh database, ${input.retest ? 'this re-test could not run, which does not show the confirmed bug is fixed: say "blocked"' : 'the failure needed data only the journey had: say "not-reproduced" too'}. Otherwise say "blocked" only when the browser or the preview stopped you, and why; that proves nothing either way. Take a screenshot of the final page either way.

${VERDICT_FORMAT}`;

export const parseVerdict = (text: string | null | undefined) => {
  if (!text) return null;
  const line = (label: string) =>
    new RegExp(`^\\s*\\**${label}\\**:\\**\\s*(.+?)\\s*$`, "im").exec(text)?.[1];
  const verdict = line("VERDICT")?.toLowerCase();
  if (verdict !== "reproduced" && verdict !== "not-reproduced" && verdict !== "blocked")
    return null;
  return {
    verdict: verdict as "reproduced" | "not-reproduced" | "blocked",
    reason: line("REASON") ?? "The replay gave no reason.",
    screenshot: line("SCREENSHOT") ?? null,
  };
};

export interface ProcessSample {
  readonly processes: number;
  readonly nice: number | null;
  readonly policy: string | null;
}

const POLICY_NAMES: Record<string, string> = {
  "0": "SCHED_OTHER",
  "3": "SCHED_BATCH",
  "5": "SCHED_IDLE",
};

/** A process's parent, nice value and scheduling policy, from `/proc/<pid>/stat`; the command may hold spaces. */
export const parseStat = (stat: string) => {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { ppid: fields[1]!, nice: Number(fields[16]), policy: fields[38]! };
};

/** What the kernel says about every process descended from a Chrome carrying this marker. */
export const sampleBrowserProcesses = (marker: string): ProcessSample => {
  const stats = new Map<string, ReturnType<typeof parseStat>>();
  const roots: string[] = [];
  for (const entry of NodeFS.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      stats.set(entry, parseStat(NodeFS.readFileSync(`/proc/${entry}/stat`, "utf8")));
      if (NodeFS.readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(marker)) roots.push(entry);
    } catch {
      // It exited between the listing and the read.
    }
  }
  const members = new Set(roots);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, stat] of stats)
      if (!members.has(pid) && members.has(stat.ppid)) {
        members.add(pid);
        grew = true;
      }
  }
  if (members.size === 0) return { processes: 0, nice: null, policy: null };
  const samples = [...members].flatMap((pid) => stats.get(pid) ?? []);
  // The highest priority found, so one process that escaped is what shows.
  const nice = Math.min(...samples.map((sample) => sample.nice));
  const policies = new Set(samples.map((sample) => POLICY_NAMES[sample.policy] ?? sample.policy));
  return { processes: samples.length, nice, policy: [...policies].toSorted().join(",") };
};
