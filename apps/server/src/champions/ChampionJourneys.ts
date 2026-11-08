// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - Reads the machine's load and memory, which the Effect platform does not expose, and probes loopback shards with no client middleware.
/**
 * A journey Champion's check: its target, the journeys the server records as they run, and the
 * candidates that stand below findings until an independent replay confirms them. The owner's model
 * plans journeys and files candidates; it never grades them, and nothing here trusts its counts.
 */
import {
  ChampionError,
  ChampionJourney,
  ChampionJourneyCheckRecord,
  ChampionJourneyManifest,
  ChampionJourneyStep,
  type ChampionJourneyConfig,
  type ChampionJourneyPlan,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import {
  JourneyBrowserPolicy,
  journeyBrowserMarker,
  type JourneyGrant,
  type JourneyNetworkDecision,
} from "../preview/JourneyBrowserPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  CANDIDATE_WORK_PREFIX,
  allowlistOf,
  incompleteReason,
  isCandidateWorkId,
  isCapacityStop,
  isLimitStop,
  journeyOutcome,
  peakConcurrency,
  percentile,
  sampleBrowserProcesses,
  targetRefusal,
  urlsOf,
  type InspectedContainer,
} from "./journeyRules.ts";

const isChampionError = Schema.is(ChampionError);
const failure = (cause: unknown) => new ChampionError({ reason: "unavailable", cause });
const refuse = (detail: string) => new ChampionError({ reason: "conflict", detail });

const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(ChampionJourneyCheckRecord));
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(ChampionJourneyCheckRecord));
const encodeJourney = Schema.encodeEffect(Schema.fromJsonString(ChampionJourney));
const decodeJourney = Schema.decodeUnknownEffect(Schema.fromJsonString(ChampionJourney));
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ChampionJourneyManifest));
const decodeCapture = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ChampionJourneyCheckRecord.fields.network.fields.capture),
);

export const JourneyCandidate = Schema.Struct({
  id: Schema.String,
  championId: Schema.String,
  checkId: Schema.String,
  /** A retest replays a confirmed finding on a later build; its verdict can close that finding. */
  kind: Schema.Literals(["candidate", "retest"]),
  status: Schema.Literals([
    "pending",
    "confirmed",
    "rejected",
    "inconclusive",
    "fixed",
    "still-failing",
  ]),
  reason: Schema.NullOr(Schema.String),
  title: Schema.String,
  expected: Schema.String,
  observed: Schema.String,
  tabId: Schema.String,
  commit: Schema.NullOr(Schema.String),
  steps: Schema.Array(ChampionJourneyStep),
  finalUrl: Schema.NullOr(Schema.String),
  screenshots: Schema.Array(Schema.String),
  findingId: Schema.NullOr(Schema.String),
  replay: Schema.NullOr(
    Schema.Struct({
      /** The only task a replay may be given: the owner must not steer its judge. */
      brief: Schema.optional(Schema.String),
      targetId: Schema.String,
      workId: Schema.String,
      attemptId: Schema.String,
      commit: Schema.String,
    }),
  ),
});
export type JourneyCandidate = typeof JourneyCandidate.Type;
const encodeCandidate = Schema.encodeEffect(Schema.fromJsonString(JourneyCandidate));
const decodeCandidate = Schema.decodeUnknownEffect(Schema.fromJsonString(JourneyCandidate));
const encodeAllow = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeAllow = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const decodeDocker = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        Config: Schema.Struct({ Env: Schema.Array(Schema.String) }),
        State: Schema.Struct({ Running: Schema.Boolean }),
        NetworkSettings: Schema.Struct({ Networks: Schema.Record(Schema.String, Schema.Unknown) }),
      }),
    ),
  ),
);

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1)$/;
const SAMPLE_EVERY = Duration.seconds(5);
const PROBE_TIMEOUT_MS = 4_000;
/** A shard this many probes behind is down, which makes the check incomplete whatever its owner says. */
const PROBES_TO_DOWN = 3;
/** Each replay is a production server and a database clone beside the journey browsers. */
export const MAX_OPEN_REPLAYS = 4;
/** One per process however many services this module serves: a check absent here outlived a restart. */
const monitors = new Map<string, Fiber.Fiber<void, never>>();
const downShards = new Map<string, string[]>();
const NETWORK_FLUSH_EVERY = Duration.seconds(2);

const argv = (template: ReadonlyArray<string>, values: Record<string, string>) =>
  template.map((part) =>
    part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole),
  );

const lastJsonLine = (stdout: string) =>
  stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .at(-1) ?? "";

const emptyRecord = (input: {
  readonly control?: boolean | undefined;
  readonly checkId: string;
  readonly championId: string;
  readonly at: string;
  readonly status: ChampionJourneyCheckRecord["status"];
  readonly reason: string | null;
  readonly load5: number;
  readonly journeyLimit: number;
  readonly decisionCap: number;
}): ChampionJourneyCheckRecord => ({
  checkId: input.checkId,
  championId: input.championId as ChampionJourneyCheckRecord["championId"],
  status: input.status,
  reason: input.reason,
  reduced: null,
  startedAt: input.at as ChampionJourneyCheckRecord["startedAt"],
  endedAt: null,
  build: null,
  commit: null,
  manifest: null,
  journeyLimit: input.journeyLimit,
  decisionCap: input.decisionCap,
  spendLimitDecisions: input.journeyLimit * input.decisionCap,
  journeys: { started: 0, passed: 0, failed: 0, stopped: 0, running: 0, stoppedByLimit: 0 },
  ownerCounts: null,
  concurrencyReached: 0,
  ceilingMeasured: 0,
  falsePositives: input.control === true ? 0 : null,
  elapsedSeconds: null,
  decisions: 0,
  usd: 0,
  unpricedCalls: 0,
  candidates: { filed: 0, confirmed: 0, rejected: 0, pending: 0, rejectionReasons: [] },
  perShard: [],
  machine: {
    load5AtStart: input.load5,
    peakCpuPercent: null,
    peakMemoryGb: null,
    browserProcesses: 0,
    browserNice: null,
    browserPolicy: null,
  },
  network: { allowed: [], blocked: [], capture: null },
});

/** The owner thread's and a replay's browser allowance; what `JourneyBrowserPolicy` reads back. */
export const layerBrowserPolicy = Layer.effect(
  JourneyBrowserPolicy,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const buffered = new Map<string, Map<string, number>>();
    const flush = Effect.gen(function* () {
      const batches = [...buffered.entries()];
      buffered.clear();
      for (const [checkId, counts] of batches)
        for (const [key, requests] of counts) {
          const allowed = key.startsWith("+") ? 1 : 0;
          const destination = key.slice(1);
          yield* sql`INSERT INTO champion_journey_network (check_id, destination, allowed, requests)
            VALUES (${checkId}, ${destination}, ${allowed}, ${requests})
            ON CONFLICT(check_id, destination, allowed) DO UPDATE SET requests = requests + excluded.requests`;
        }
    }).pipe(Effect.ignore);
    yield* flush.pipe(Effect.repeat(Schedule.spaced(NETWORK_FLUSH_EVERY)), Effect.forkScoped);

    const forThread = Effect.fn("JourneyBrowserPolicy.forThread")(
      function* (threadId: ThreadId) {
        const direct =
          yield* sql<GrantRow>`SELECT * FROM champion_journey_grants WHERE grant_key = ${threadId}`;
        if (direct[0] !== undefined) return yield* grantOf(direct[0]);
        // A replay's child is known by the workId the server gave its owner. The thread's record is
        // the only place that link lives, and the projection is what every reader of it uses.
        const [thread] = yield* sql<{ work_id: string | null }>`
          SELECT json_extract(payload_json, '$.agentTask.workId') AS work_id
          FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
        if (!isCandidateWorkId(thread?.work_id ?? undefined)) return undefined;
        const [row] =
          yield* sql<GrantRow>`SELECT * FROM champion_journey_grants WHERE grant_key = ${thread!.work_id!}`;
        // Fails closed: a replay whose grant is gone may reach nothing.
        return row === undefined
          ? { checkId: "ended", allow: [], tabLimit: 0, decisionCap: 0, journeyLimit: 0 }
          : yield* grantOf(row);
      },
      // A broken ledger must not silently give a journey an ordinary browser.
      Effect.orElseSucceed((): JourneyGrant => ({
        checkId: "unavailable",
        allow: [],
        tabLimit: 0,
        decisionCap: 0,
        journeyLimit: 0,
      })),
    );

    const readJourney = Effect.fn("JourneyBrowserPolicy.readJourney")(function* (id: string) {
      const [row] = yield* sql<{
        document_json: string;
      }>`SELECT document_json FROM champion_journeys WHERE id = ${id}`;
      return row === undefined ? undefined : yield* decodeJourney(row.document_json);
    });

    return JourneyBrowserPolicy.of({
      forThread,
      record: (checkId, decision: JourneyNetworkDecision) => {
        const counts = buffered.get(checkId) ?? new Map<string, number>();
        const key = `${decision.allowed ? "+" : "-"}${decision.host}:${decision.port}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        buffered.set(checkId, counts);
      },
      admitTask: Effect.fn("JourneyBrowserPolicy.admitTask")(
        function* ({ grant, tabId }) {
          const existing = yield* readJourney(`${grant.checkId}:${tabId}`);
          if (existing === undefined) {
            const [count] = yield* sql<{
              n: number;
            }>`SELECT count(*) AS n FROM champion_journeys WHERE check_id = ${grant.checkId}`;
            if ((count?.n ?? 0) >= grant.journeyLimit)
              return {
                _tag: "refused" as const,
                message: `This check has run all ${grant.journeyLimit} of its journeys.`,
              };
          }
          const remaining = grant.decisionCap - (existing?.decisions ?? 0);
          if (remaining <= 0)
            return {
              _tag: "refused" as const,
              message: `This journey has spent its ${grant.decisionCap} decisions. Start another journey in a new tab, or finish.`,
            };
          // Recording the start here, not at the end, is what lets a stopped task still count against the check.
          if (existing === undefined) {
            const journey: ChampionJourney = {
              id: `${grant.checkId}:${tabId}`,
              checkId: grant.checkId,
              tabId,
              shard: null,
              goals: [],
              startedAt: DateTime.formatIso(yield* DateTime.now) as ChampionJourney["startedAt"],
              endedAt: null,
              outcome: "running",
              reason: null,
              stoppedByLimit: false,
              decisions: 0,
              usd: 0,
              unreportedCalls: 0,
              finalUrl: null,
              screenshots: [],
              steps: [],
            };
            yield* sql`INSERT INTO champion_journeys (id, check_id, started_at, document_json)
              VALUES (${journey.id}, ${grant.checkId}, ${journey.startedAt}, ${yield* encodeJourney(journey)})
              ON CONFLICT(id) DO NOTHING`;
          }
          return { _tag: "admitted" as const, decisions: remaining };
        },
        Effect.orElseSucceed(() => ({
          _tag: "refused" as const,
          message: "The check's journey ledger is unavailable, so no journey starts.",
        })),
      ),
      recordTask: Effect.fn("JourneyBrowserPolicy.recordTask")(
        function* ({ grant, tabId, goal, endedAt, result, steps }) {
          const id = `${grant.checkId}:${tabId}`;
          const existing = yield* readJourney(id);
          if (existing === undefined) return;
          const url = result.evidence.url;
          const origin = url === null ? null : originPort(url);
          const journey: ChampionJourney = {
            ...existing,
            shard: existing.shard ?? origin,
            goals: goal === null ? existing.goals : [...existing.goals, goal],
            endedAt: endedAt as ChampionJourney["startedAt"],
            // A later task's pass does not hide an earlier failure in the same journey.
            outcome: existing.outcome === "failed" ? "failed" : journeyOutcome(result.status),
            reason: result.reason ?? existing.reason,
            stoppedByLimit: existing.stoppedByLimit || isLimitStop(result.reason),
            decisions: existing.decisions + result.decisions,
            usd: existing.usd + result.usage.usd,
            unreportedCalls: existing.unreportedCalls + result.usage.unreportedCalls,
            finalUrl: url ?? existing.finalUrl,
            screenshots: [
              ...existing.screenshots,
              ...(result.screenshots ?? []).map((screenshot) => screenshot.path),
            ],
            steps: [...existing.steps, ...steps],
          };
          yield* sql`UPDATE champion_journeys SET document_json = ${yield* encodeJourney(journey)} WHERE id = ${id}`;
        },
        Effect.catchCause((cause) => Effect.logError("journey record failed", { cause })),
      ),
    });
  }),
);

interface GrantRow {
  readonly grant_key: string;
  readonly check_id: string;
  readonly allow_json: string;
  readonly tab_limit: number;
  readonly decision_cap: number;
  readonly journey_limit: number;
}

const grantOf = (row: GrantRow) =>
  decodeAllow(row.allow_json).pipe(
    Effect.map((allow): JourneyGrant => ({
      checkId: row.check_id,
      allow,
      tabLimit: row.tab_limit,
      decisionCap: row.decision_cap,
      journeyLimit: row.journey_limit,
    })),
  );

const originPort = (url: string) => {
  try {
    const parsed = new URL(url);
    return LOOPBACK_HOST.test(parsed.hostname) ? parsed.port : null;
  } catch {
    return null;
  }
};

/** Memory in use across the machine, in GB, the way `free` counts "available". */
const memoryUsedGb = () => {
  const info = NodeFS.readFileSync("/proc/meminfo", "utf8");
  const value = (name: string) =>
    Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(info)?.[1] ?? 0);
  return (value("MemTotal") - value("MemAvailable")) / 1024 / 1024;
};

const cpuTimes = () => {
  const fields = NodeFS.readFileSync("/proc/stat", "utf8")
    .split("\n")[0]!
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  return { idle, total: fields.reduce((sum, value) => sum + value, 0) };
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const processes = yield* ProcessRunner.ProcessRunner;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const runJson = Effect.fn("ChampionJourneys.runJson")(function* (
    command: ReadonlyArray<string>,
    timeoutMinutes: number,
  ) {
    const [executable, ...args] = command;
    const output = yield* processes
      .run({
        command: executable!,
        args,
        timeout: Duration.minutes(timeoutMinutes),
        maxOutputBytes: 4 * 1024 * 1024,
        outputMode: "truncate-tail",
      })
      .pipe(Effect.mapError(failure));
    if (output.code !== 0)
      return yield* new ChampionError({
        reason: "unavailable",
        detail: `${executable} exited ${output.code}: ${output.stderr.slice(-600)}`,
      });
    return lastJsonLine(output.stdout);
  });

  const inspect = Effect.fn("ChampionJourneys.inspect")(function* (
    manifest: ChampionJourneyManifest,
  ) {
    const containers: InspectedContainer[] = [];
    for (const shard of manifest.shards) {
      const output = yield* processes
        .run({
          command: "docker",
          args: ["inspect", shard.container],
          timeout: Duration.seconds(30),
        })
        .pipe(Effect.mapError(failure));
      if (output.code !== 0) continue;
      const parsed = (yield* decodeDocker(output.stdout))[0];
      if (parsed === undefined) continue;
      const environment = parsed.Config.Env.map(
        (entry) => entry.split("=", 2) as [string, string?],
      );
      const url = environment.find(([name]) => name === "DATABASE_URL")?.[1];
      const full = parsed.Config.Env.find((entry) => entry.startsWith("DATABASE_URL="))?.slice(13);
      const networks: { name: string; internal: boolean }[] = [];
      for (const name of Object.keys(parsed.NetworkSettings.Networks)) {
        const network = yield* processes
          .run({
            command: "docker",
            args: ["network", "inspect", name, "--format", "{{.Internal}}"],
            timeout: Duration.seconds(30),
          })
          .pipe(Effect.mapError(failure));
        networks.push({ name, internal: network.stdout.trim() === "true" });
      }
      containers.push({
        name: shard.container,
        running: parsed.State.Running,
        environmentNames: environment.map(([name]) => name),
        databaseName:
          full === undefined || url === undefined
            ? null
            : new URL(full).pathname.replace(/^\//, ""),
        networks,
      });
    }
    return containers;
  });

  const saveRecord = Effect.fn("ChampionJourneys.saveRecord")(function* (
    threadId: string,
    record: ChampionJourneyCheckRecord,
  ) {
    yield* sql`INSERT INTO champion_journey_checks (check_id, champion_id, thread_id, status, started_at, document_json)
      VALUES (${record.checkId}, ${record.championId}, ${threadId}, ${record.status}, ${record.startedAt}, ${yield* encodeRecord(record)})
      ON CONFLICT(check_id) DO UPDATE SET status = excluded.status, document_json = excluded.document_json`;
  });
  const readRecord = Effect.fn("ChampionJourneys.readRecord")(function* (checkId: string) {
    const [row] = yield* sql<{
      document_json: string;
      thread_id: string;
    }>`SELECT document_json, thread_id FROM champion_journey_checks WHERE check_id = ${checkId}`;
    if (row === undefined) return undefined;
    return { record: yield* decodeRecord(row.document_json), threadId: row.thread_id as ThreadId };
  });

  const latestCheckOf = Effect.fn("ChampionJourneys.latestCheckOf")(function* (threadId: string) {
    const [row] = yield* sql<{ check_id: string }>`
      SELECT check_id FROM champion_journey_checks
      WHERE thread_id = ${threadId} ORDER BY started_at DESC LIMIT 1`;
    return row?.check_id;
  });

  const journeysOf = Effect.fn("ChampionJourneys.journeysOf")(function* (checkId: string) {
    const rows = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_journeys WHERE check_id = ${checkId} ORDER BY started_at`;
    return yield* Effect.forEach(rows, (row) => decodeJourney(row.document_json));
  });

  const candidatesOf = Effect.fn("ChampionJourneys.candidatesOf")(function* (checkId: string) {
    const rows = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_journey_candidates WHERE check_id = ${checkId} ORDER BY created_at`;
    return yield* Effect.forEach(rows, (row) => decodeCandidate(row.document_json));
  });
  const readCandidate = Effect.fn("ChampionJourneys.readCandidate")(function* (id: string) {
    const [row] = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_journey_candidates WHERE id = ${id}`;
    return row === undefined ? undefined : yield* decodeCandidate(row.document_json);
  });
  /** The confirmed journey behind a finding, whichever check found it. */
  const confirmedFor = Effect.fn("ChampionJourneys.confirmedFor")(function* (findingId: string) {
    const [row] = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_journey_candidates
      WHERE finding_id = ${findingId} AND status = 'confirmed' ORDER BY created_at LIMIT 1`;
    return row === undefined ? undefined : yield* decodeCandidate(row.document_json);
  });
  const saveCandidate = Effect.fn("ChampionJourneys.saveCandidate")(function* (
    candidate: JourneyCandidate,
  ) {
    yield* sql`INSERT INTO champion_journey_candidates (id, champion_id, check_id, status, finding_id, created_at, document_json)
      VALUES (${candidate.id}, ${candidate.championId}, ${candidate.checkId}, ${candidate.status}, ${candidate.findingId}, ${yield* now}, ${yield* encodeCandidate(candidate)})
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, finding_id = excluded.finding_id, document_json = excluded.document_json`;
  });

  const setGrant = Effect.fn("ChampionJourneys.setGrant")(function* (
    key: string,
    grant: JourneyGrant,
  ) {
    yield* sql`INSERT INTO champion_journey_grants (grant_key, check_id, allow_json, tab_limit, decision_cap, journey_limit)
      VALUES (${key}, ${grant.checkId}, ${yield* encodeAllow(grant.allow)}, ${grant.tabLimit}, ${grant.decisionCap}, ${grant.journeyLimit})
      ON CONFLICT(grant_key) DO UPDATE SET check_id = excluded.check_id, allow_json = excluded.allow_json,
        tab_limit = excluded.tab_limit, decision_cap = excluded.decision_cap, journey_limit = excluded.journey_limit`;
  });

  /** A journey Champion's thread browses nothing outside a check: not its goals' pages, not anywhere. */
  const fenceThread = (threadId: string, checkId: string) =>
    setGrant(threadId, { checkId, allow: [], tabLimit: 0, decisionCap: 0, journeyLimit: 0 });

  /** Whether this thread's journey check holds a live target, when the only delegation it may make is a replay. */
  const ownerBusy = Effect.fn("ChampionJourneys.ownerBusy")(function* (threadId: string) {
    const rows = yield* sql<{ allow_json: string }>`
      SELECT allow_json FROM champion_journey_grants WHERE grant_key = ${threadId}`;
    return rows[0] !== undefined && rows[0].allow_json !== "[]";
  });

  const peakOfCheck = Effect.fn("ChampionJourneys.peakOfCheck")(function* (championId: string) {
    const rows = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_journey_checks
      WHERE champion_id = ${championId} AND status IN ('complete','incomplete')`;
    let ceiling = 0;
    for (const row of rows) {
      const record = yield* decodeRecord(row.document_json);
      ceiling = Math.max(ceiling, record.ceilingMeasured);
    }
    return ceiling;
  });

  /** Samples the machine and every shard for as long as the check runs. */
  const monitor = Effect.fn("ChampionJourneys.monitor")(function* (
    threadId: string,
    checkId: string,
    manifest: ChampionJourneyManifest,
  ) {
    const probes = new Map<string, { failures: number; streak: number; ms: number[] }>(
      manifest.shards.map((shard) => [shard.id, { failures: 0, streak: 0, ms: [] }]),
    );
    let cpu = cpuTimes();
    const sample = Effect.gen(function* () {
      yield* Effect.forEach(
        manifest.shards,
        (shard) =>
          Effect.promise(async () => {
            const started = performance.now();
            const state = probes.get(shard.id)!;
            try {
              const answer = await fetch(`${shard.origin}/login`, {
                redirect: "manual",
                signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
              });
              if (answer.status >= 500) throw new Error(String(answer.status));
              state.ms.push(performance.now() - started);
              state.streak = 0;
            } catch {
              state.failures += 1;
              state.streak += 1;
            }
          }),
        { concurrency: "unbounded" },
      );
      const current = yield* readRecord(checkId);
      if (current === undefined) return;
      const times = cpuTimes();
      const busy =
        times.total === cpu.total
          ? null
          : 100 * (1 - (times.idle - cpu.idle) / (times.total - cpu.total));
      cpu = times;
      const browsers = yield* Effect.sync(() =>
        sampleBrowserProcesses(journeyBrowserMarker(checkId)),
      );
      const { machine } = current.record;
      yield* saveRecord(threadId, {
        ...current.record,
        perShard: manifest.shards.map((shard) => {
          const state = probes.get(shard.id)!;
          return {
            shard: shard.id,
            journeys: 0,
            stepMsP50: null,
            stepMsP95: null,
            pageMsP50: percentile(state.ms, 0.5),
            pageMsP95: percentile(state.ms, 0.95),
            probeFailures: state.failures,
          };
        }),
        machine: {
          ...machine,
          peakCpuPercent: Math.max(machine.peakCpuPercent ?? 0, busy ?? 0),
          peakMemoryGb: Math.max(machine.peakMemoryGb ?? 0, memoryUsedGb()),
          ...(browsers.processes >= machine.browserProcesses
            ? {
                browserProcesses: browsers.processes,
                browserNice: browsers.nice ?? machine.browserNice,
                browserPolicy: browsers.policy ?? machine.browserPolicy,
              }
            : {}),
        },
        reason: current.record.reason,
      });
      downShards.set(
        checkId,
        manifest.shards
          .filter((shard) => {
            const state = probes.get(shard.id)!;
            return (
              state.streak >= PROBES_TO_DOWN || (downShards.get(checkId) ?? []).includes(shard.id)
            );
          })
          .map((shard) => shard.id),
      );
    }).pipe(Effect.ignore);
    yield* sample.pipe(Effect.repeat(Schedule.spaced(SAMPLE_EVERY)));
  }, Effect.asVoid);

  /** The last word on a shard the monitor may have last seen moments before it stopped. */
  const unanswering = Effect.fn("ChampionJourneys.unanswering")(function* (
    manifest: ChampionJourneyManifest,
  ) {
    const answers = yield* Effect.forEach(
      manifest.shards,
      (shard) =>
        Effect.tryPromise({
          try: () =>
            fetch(`${shard.origin}/login`, {
              redirect: "manual",
              signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            }).then((answer) => answer.status < 500),
          catch: failure,
        }).pipe(
          Effect.orElseSucceed(() => false),
          Effect.map((answered) => (answered ? [] : [shard.id])),
        ),
      { concurrency: "unbounded" },
    );
    return answers.flat();
  });

  const stopMonitor = (checkId: string) =>
    Effect.suspend(() => {
      const fiber = monitors.get(checkId);
      monitors.delete(checkId);
      return fiber === undefined ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.asVoid);
    });

  /** Reads the record's server-derived fields fresh; a monitor's write may land between two reads. */
  const summarise = Effect.fn("ChampionJourneys.summarise")(function* (
    record: ChampionJourneyCheckRecord,
  ) {
    const journeys = yield* journeysOf(record.checkId);
    const candidates = yield* candidatesOf(record.checkId);
    const network = yield* sql<{ destination: string; allowed: number; requests: number }>`
      SELECT destination, allowed, requests FROM champion_journey_network WHERE check_id = ${record.checkId} ORDER BY requests DESC`;
    const at = Date.parse(yield* now);
    const started = journeys.map((journey) => Date.parse(journey.startedAt));
    const ended = journeys.flatMap((journey) =>
      journey.endedAt === null ? [] : [Date.parse(journey.endedAt)],
    );
    const origins = new Map(
      (record.manifest?.shards ?? []).map((shard) => [new URL(shard.origin).port, shard.id]),
    );
    const rejected = candidates.filter((candidate) => candidate.status === "rejected");
    const confirmed = candidates.filter((candidate) => candidate.status === "confirmed").length;
    return {
      ...record,
      falsePositives: record.falsePositives === null ? null : confirmed,
      journeys: {
        started: journeys.length,
        passed: journeys.filter((journey) => journey.outcome === "passed").length,
        failed: journeys.filter((journey) => journey.outcome === "failed").length,
        stopped: journeys.filter((journey) => journey.outcome === "stopped").length,
        running: journeys.filter((journey) => journey.outcome === "running").length,
        stoppedByLimit: journeys.filter((journey) => journey.stoppedByLimit).length,
      },
      concurrencyReached: peakConcurrency(journeys, at),
      elapsedSeconds:
        started.length === 0
          ? null
          : (Math.max(...ended, Math.min(...started)) - Math.min(...started)) / 1000,
      decisions: journeys.reduce((sum, journey) => sum + journey.decisions, 0),
      usd: journeys.reduce((sum, journey) => sum + journey.usd, 0),
      unpricedCalls: journeys.reduce((sum, journey) => sum + journey.unreportedCalls, 0),
      candidates: {
        filed: candidates.filter((candidate) => candidate.kind === "candidate").length,
        confirmed,
        rejected: rejected.length,
        // A re-test that proves nothing leaves its bug open for a later check; it does not spoil this one.
        pending: candidates.filter(
          (candidate) =>
            candidate.kind === "candidate" &&
            (candidate.status === "pending" || candidate.status === "inconclusive"),
        ).length,
        rejectionReasons: rejected.flatMap((candidate) => candidate.reason ?? []).slice(0, 32),
      },
      perShard: record.perShard.map((entry) => {
        const own = journeys.filter(
          (journey) => journey.shard !== null && origins.get(journey.shard) === entry.shard,
        );
        const steps = own.flatMap((journey) => journey.steps.map((step) => step.ms));
        return {
          ...entry,
          journeys: own.length,
          stepMsP50: percentile(steps, 0.5),
          stepMsP95: percentile(steps, 0.95),
        };
      }),
      network: {
        ...record.network,
        allowed: network
          .filter((row) => row.allowed === 1)
          .map(({ destination, requests }) => ({ destination, requests })),
        blocked: network
          .filter((row) => row.allowed === 0)
          .map(({ destination, requests }) => ({ destination, requests })),
      },
    } satisfies ChampionJourneyCheckRecord;
  });

  const finish = Effect.fn("ChampionJourneys.finish")(
    function* (input: {
      readonly checkId: string;
      readonly championId: string;
      readonly threadId: string;
      readonly config: ChampionJourneyConfig;
      readonly owner: ChampionJourneyCheckRecord["ownerCounts"] | undefined;
      /** Why the check cannot be complete, when that is already known. */
      readonly forcedReason?: string;
    }) {
      const stored = yield* readRecord(input.checkId);
      if (stored === undefined || stored.record.status !== "running") return stored?.record;
      yield* stopMonitor(input.checkId);
      const record = yield* summarise(stored.record);
      for (const candidate of yield* candidatesOf(input.checkId))
        if (candidate.status === "pending" && candidate.replay !== null)
          yield* endReplay({
            checkId: input.checkId,
            config: input.config,
            workId: candidate.replay.workId,
            targetId: candidate.replay.targetId,
          });
      const capture =
        record.manifest === null
          ? null
          : yield* runJson(argv(input.config.capture, { id: record.manifest.id }), 2).pipe(
              Effect.flatMap(decodeCapture),
              Effect.orElseSucceed(() => null),
            );
      const stoppedLately = record.manifest === null ? [] : yield* unanswering(record.manifest);
      const reason =
        input.forcedReason ??
        incompleteReason({
          served: record.journeys,
          owner: input.owner ?? undefined,
          journeyLimit: record.journeyLimit,
          downShards: [...new Set([...(downShards.get(input.checkId) ?? []), ...stoppedLately])],
          pendingCandidates: record.candidates.pending,
          capture: record.manifest === null ? { outside: [] } : capture,
        });
      downShards.delete(input.checkId);
      if (record.manifest !== null)
        yield* runJson(argv(input.config.teardown, { id: record.manifest.id }), 5).pipe(
          Effect.ignore,
        );
      yield* fenceThread(input.threadId, input.checkId);
      const final: ChampionJourneyCheckRecord = {
        ...record,
        status: reason === null ? "complete" : "incomplete",
        reason,
        endedAt: (yield* now) as ChampionJourneyCheckRecord["startedAt"],
        ownerCounts: input.owner ?? null,
        network: { ...record.network, capture },
      };
      const ranShort = (yield* journeysOf(input.checkId)).some((journey) =>
        isCapacityStop(journey.reason),
      );
      const ceiling = Math.max(
        ranShort ? 0 : final.concurrencyReached,
        yield* peakOfCheck(input.championId),
      );
      const saved = { ...final, ceilingMeasured: ceiling };
      yield* saveRecord(input.threadId, saved);
      return saved;
    },
    Effect.mapError((cause) => (isChampionError(cause) ? cause : failure(cause))),
  );

  /** A journey the owner saw fail, whatever its task's status said. */
  const markFailed = Effect.fn("ChampionJourneys.markFailed")(function* (
    checkId: string,
    tabId: string,
  ) {
    const id = `${checkId}:${tabId}`;
    const [row] = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_journeys WHERE id = ${id}`;
    if (row === undefined) return undefined;
    const journey = yield* decodeJourney(row.document_json);
    const failed: ChampionJourney = { ...journey, outcome: "failed" };
    yield* sql`UPDATE champion_journeys SET document_json = ${yield* encodeJourney(failed)} WHERE id = ${id}`;
    return failed;
  });

  const overLoadLimit = (config: ChampionJourneyConfig) => {
    const load5 = NodeOS.loadavg()[1]!;
    return load5 <= config.loadLimit
      ? null
      : `The machine's 5-minute load is ${load5.toFixed(1)}, above the limit of ${config.loadLimit}.`;
  };

  /** Records a check that did not start because the machine was busy; true when that is so. */
  const deferred = Effect.fn("ChampionJourneys.deferred")(function* (input: {
    readonly championId: string;
    readonly threadId: string;
    readonly config: ChampionJourneyConfig;
    readonly checkId: string;
  }) {
    const reason = overLoadLimit(input.config);
    if (reason === null) return null;
    const load5 = NodeOS.loadavg()[1]!;
    yield* saveRecord(
      input.threadId,
      emptyRecord({
        checkId: input.checkId,
        championId: input.championId,
        at: yield* now,
        status: "deferred",
        reason,
        load5,
        journeyLimit: input.config.shards * input.config.journeysPerShard,
        decisionCap: input.config.decisionCap,
      }),
    );
    return reason;
  }, Effect.mapError(failure));

  /** Checks recorded as running that this server is not watching: it restarted, or the check ended without a report. */
  const orphanedChecks = Effect.fn("ChampionJourneys.orphanedChecks")(function* (
    championId: string,
  ) {
    const rows = yield* sql<{
      check_id: string;
    }>`SELECT check_id FROM champion_journey_checks WHERE champion_id = ${championId} AND status = 'running'`;
    return rows.map((row) => row.check_id).filter((checkId) => !monitors.has(checkId));
  }, Effect.mapError(failure));

  const start = Effect.fn("ChampionJourneys.start")(
    function* (input: {
      readonly championId: string;
      readonly threadId: ThreadId;
      readonly checkId: string;
      readonly config: ChampionJourneyConfig;
      readonly openFindings: ReadonlyArray<{ readonly id: string; readonly title: string }>;
      readonly checkoutRoot: string | null;
    }) {
      const { config, checkId, threadId } = input;
      const existing = yield* readRecord(checkId);
      if (
        existing !== undefined &&
        existing.record.manifest !== null &&
        existing.record.status === "running"
      )
        return yield* plan(input, existing.record, existing.record.manifest);
      const tooBusy = yield* deferred({ championId: input.championId, threadId, config, checkId });
      if (tooBusy !== null)
        return yield* refuse(`Deferred: ${tooBusy} Report that no journey ran.`);
      const load5 = NodeOS.loadavg()[1]!;
      const at = yield* now;
      // Close to the limit a check runs small, and says so, rather than waiting.
      const reduced = load5 > config.loadLimit * 0.75;
      const shards = reduced ? Math.max(1, Math.ceil(config.shards / 2)) : config.shards;
      const journeyLimit = shards * config.journeysPerShard;
      const reducedReason = reduced
        ? `Run at ${shards} of ${config.shards} shards because the machine's 5-minute load was ${load5.toFixed(1)}.`
        : null;
      yield* fenceThread(threadId, checkId);
      const manifest = yield* runJson(argv(config.provision, { shards: String(shards) }), 20).pipe(
        Effect.flatMap((line) => decodeManifest(line).pipe(Effect.mapError(failure))),
      );
      const refusal = targetRefusal(manifest, yield* inspect(manifest));
      if (refusal !== null) {
        yield* runJson(argv(config.teardown, { id: manifest.id }), 5).pipe(Effect.ignore);
        yield* saveRecord(
          threadId,
          emptyRecord({
            checkId,
            championId: input.championId,
            at,
            status: "refused",
            reason: refusal,
            load5,
            journeyLimit,
            decisionCap: config.decisionCap,
          }),
        );
        return yield* refuse(`The target was refused before any browser started: ${refusal}`);
      }
      const record: ChampionJourneyCheckRecord = {
        ...emptyRecord({
          checkId,
          championId: input.championId,
          at,
          status: "running",
          reason: null,
          load5,
          journeyLimit,
          decisionCap: config.decisionCap,
          control: config.control,
        }),
        reduced: reducedReason,
        build: manifest.build,
        commit: manifest.commit,
        manifest,
      };
      yield* saveRecord(threadId, record);
      yield* setGrant(threadId, {
        checkId,
        allow: allowlistOf(manifest),
        tabLimit: journeyLimit,
        decisionCap: config.decisionCap,
        journeyLimit,
      });
      monitors.set(checkId, yield* Effect.forkDetach(monitor(threadId, checkId, manifest)));
      return yield* plan(input, record, manifest);
    },
    Effect.mapError((cause) => (isChampionError(cause) ? cause : failure(cause))),
  );

  const plan = Effect.fn("ChampionJourneys.plan")(function* (
    input: {
      readonly championId: string;
      readonly checkId: string;
      readonly config: ChampionJourneyConfig;
      readonly openFindings: ReadonlyArray<{ readonly id: string; readonly title: string }>;
      readonly checkoutRoot: string | null;
    },
    record: ChampionJourneyCheckRecord,
    manifest: ChampionJourneyManifest,
  ) {
    const earlier = yield* sql<{ check_id: string; document_json: string }>`
      SELECT check_id, document_json FROM champion_journey_checks
      WHERE champion_id = ${input.championId} AND check_id != ${input.checkId} AND status IN ('complete','incomplete')
      ORDER BY started_at DESC LIMIT 16`;
    const covered: { commit: string | null; urls: string[] }[] = [];
    for (const row of earlier) {
      const prior = yield* decodeRecord(row.document_json);
      const journeys = yield* journeysOf(row.check_id);
      covered.push({
        commit: prior.commit,
        urls: [...new Set(journeys.flatMap((journey) => urlsOf(journey.steps)))].slice(0, 200),
      });
    }
    const lastCommit =
      earlier[0] === undefined ? null : (yield* decodeRecord(earlier[0].document_json)).commit;
    const changed =
      lastCommit === null || input.checkoutRoot === null || lastCommit === manifest.commit
        ? []
        : yield* processes
            .run({
              command: "git",
              args: [
                "-C",
                input.checkoutRoot,
                "diff",
                "--name-only",
                `${lastCommit}..${manifest.commit}`,
              ],
              timeout: Duration.seconds(30),
            })
            .pipe(
              Effect.map((output) =>
                output.code === 0 ? output.stdout.split("\n").filter(Boolean) : [],
              ),
              Effect.orElseSucceed(() => [] as string[]),
            );
    // Passing again on the build it failed on would prove nothing, so a re-test waits for a new one.
    const retests = (yield* Effect.forEach(input.openFindings, (finding) =>
      confirmedFor(finding.id).pipe(
        Effect.map((original) =>
          original?.commit === manifest.commit
            ? []
            : [{ findingId: finding.id, title: finding.title }],
        ),
      ),
    )).flat();
    const result: ChampionJourneyPlan = {
      checkId: input.checkId,
      commit: manifest.commit,
      shards: manifest.shards,
      journeyLimit: record.journeyLimit,
      journeysPerShard: input.config.journeysPerShard,
      decisionCap: input.config.decisionCap,
      reduced: record.reduced,
      covered: covered.slice(0, 64),
      changedSinceLastCheck: changed.slice(0, 200),
      retests,
    };
    return result;
  });

  const recordOf = Effect.fn("ChampionJourneys.recordOf")(
    function* (checkId: string, includeJourneys: boolean) {
      const stored = yield* readRecord(checkId);
      if (stored === undefined) return yield* new ChampionError({ reason: "not-found" });
      const record =
        stored.record.status === "running" ? yield* summarise(stored.record) : stored.record;
      return {
        record,
        ...(includeJourneys ? { journeys: yield* journeysOf(checkId) } : {}),
      };
    },
    Effect.mapError((cause) => (isChampionError(cause) ? cause : failure(cause))),
  );

  const provisionReplay = Effect.fn("ChampionJourneys.provisionReplay")(
    function* (input: {
      readonly checkId: string;
      readonly config: ChampionJourneyConfig;
      readonly workId: string;
      readonly build: string;
    }) {
      const open = (yield* candidatesOf(input.checkId)).filter(
        (candidate) => candidate.status === "pending" && candidate.replay !== null,
      );
      if (open.length >= MAX_OPEN_REPLAYS)
        return yield* new ChampionError({
          reason: "conflict",
          detail: `${MAX_OPEN_REPLAYS} replays are running. Settle one before starting another.`,
        });
      const tooBusy = overLoadLimit(input.config);
      if (tooBusy !== null) return yield* refuse(`Replay not started: ${tooBusy}`);
      const command = [...argv(input.config.provision, { shards: "1" }), "--build", input.build];
      const manifest = yield* runJson(command, 20).pipe(
        Effect.flatMap((line) => decodeManifest(line).pipe(Effect.mapError(failure))),
      );
      const refusal = targetRefusal(manifest, yield* inspect(manifest));
      if (refusal !== null) {
        yield* runJson(argv(input.config.teardown, { id: manifest.id }), 5).pipe(Effect.ignore);
        return yield* refuse(`The replay's target was refused: ${refusal}`);
      }
      yield* setGrant(input.workId, {
        checkId: input.checkId,
        allow: allowlistOf(manifest),
        tabLimit: 2,
        decisionCap: 0,
        journeyLimit: 0,
      });
      return manifest;
    },
    Effect.mapError((cause) => (isChampionError(cause) ? cause : failure(cause))),
  );

  const endReplay = Effect.fn("ChampionJourneys.endReplay")(function* (input: {
    readonly checkId: string;
    readonly config: ChampionJourneyConfig;
    readonly workId: string;
    readonly targetId: string;
  }) {
    yield* setGrant(input.workId, {
      checkId: input.checkId,
      allow: [],
      tabLimit: 0,
      decisionCap: 0,
      journeyLimit: 0,
    });
    yield* runJson(argv(input.config.teardown, { id: input.targetId }), 5).pipe(Effect.ignore);
  }, Effect.mapError(failure));

  return {
    overLoadLimit,
    ownerBusy,
    latestCheckOf,
    start,
    finish,
    recordOf,
    readRecord,
    journeysOf,
    candidatesOf,
    markFailed,
    deferred,
    orphanedChecks,
    readCandidate,
    confirmedFor,
    saveCandidate,
    fenceThread,
    provisionReplay,
    endReplay,
    candidateWorkId: (id: string) => `${CANDIDATE_WORK_PREFIX}${id}`,
  };
});
