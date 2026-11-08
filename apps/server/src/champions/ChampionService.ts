import * as ChampionEvidence from "./ChampionEvidence.ts";
import * as ChampionJourneys from "./ChampionJourneys.ts";
import {
  CANDIDATE_WORK_PREFIX,
  describeSteps,
  isCandidateWorkId,
  parseVerdict,
  replayBrief,
} from "./journeyRules.ts";
import { engines as decisionEngines } from "../decisions/adapters.ts";
import * as ChampionLearnings from "./ChampionLearnings.ts";
import * as ManagedTaskControl from "../agents/ManagedTaskControl.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { forgeItemNumberFromUrl } from "@t3tools/shared/forgeLinks";
import * as ProcessRunner from "../processRunner.ts";
import * as SlipJayLandings from "../project/SlipJayLandings.ts";
import { invalidOptionSelections } from "../provider/modelSelectionValidation.ts";
import { isProviderUsageExhausted } from "@t3tools/shared/providerPools";
import {
  isProviderOverloadedFailureCode,
  ChampionExecutionAttempt,
  type ChampionClassChoicesInput,
  type ChampionClassChoicesResult,
  ChampionSummary,
  type ChampionLatestSample,
  ChampionDetail,
  ChampionMetric,
  ChampionPendingProposal,
  type ChampionProposal,
  type ChampionAcceptInput,
  type ChampionRelayedApproval,
  ChampionFinding,
  ChampionSample,
  ChampionActivity,
  ChampionCharter,
  ChampionError,
  DEFAULT_CHAMPION_INSTRUCTIONS,
  CommandId,
  MessageId,
  ThreadId,
  type ChampionConfig,
  type ChampionMetricInput,
  type ChampionReportInput,
  type ChampionSampleInput,
  type ChampionLifecycle,
  type ChampionHistoryInput,
  type ChampionHistoryResult,
  type ChampionFindingActionInput,
  type ChampionFindingDeliveryInput,
  type ChampionCheckContext,
  type AgentTaskRequest,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2ConversationMessage,
  type RunId,
  type ChampionLearningContributor,
  type ChampionLearningContributeInput,
  type ChampionLearningConfirmInput,
  type ChampionLearningNoteInput,
  type ChampionCandidateReplay,
  type ChampionCandidateReplayInput,
  type ChampionCandidateSettled,
  type ChampionJourneyCandidateInput,
  type ChampionJourneyPlan,
  type ChampionJourneyRecordResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { nextScheduledRunAt, isSameSchedule } from "../scheduledTasks/Schedule.ts";
import type { McpThreadCaller } from "../mcp/McpInvocationContext.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const sameFinding = Schema.toEquivalence(ChampionFinding);

const Document = Schema.Struct({
  champion: ChampionSummary,
  metrics: Schema.Array(ChampionMetric),
  proposal: Schema.NullOr(ChampionPendingProposal),
  findings: Schema.Array(ChampionFinding),
});
type Document = typeof Document.Type;
const Check = Schema.Struct({
  id: Schema.String,
  championId: Schema.String,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  executionAttempt: Schema.optional(ChampionExecutionAttempt),
  kind: Schema.Literals(["setup", "check"]),
  startedAt: Schema.String,
  measureOnly: Schema.Boolean,
  metrics: Schema.Array(ChampionMetric),
  reported: Schema.Boolean,
  dispatched: Schema.Boolean,
  launchStarted: Schema.optional(Schema.Boolean),
  dispatchKind: Schema.Literals(["launch", "send"]),
  samples: Schema.optional(Schema.Array(ChampionSample)),
  cancelled: Schema.optional(Schema.Boolean),
  /** Retries the server started on its own for this claim; manual retries are not counted. */
  automaticRetries: Schema.optional(Schema.Number),
});
type Check = typeof Check.Type;
/** A claim's own retries stop here, so a lasting outage cannot keep spending on it. */
const MAX_AUTOMATIC_CHECK_RETRIES = 3;
// Only persisted server restart ancestry carries a claim across messages.
function checkRunMessages(run: OrchestrationV2Run, runs: ReadonlyMap<RunId, OrchestrationV2Run>) {
  const messages = [run.userMessageId];
  let current = run;
  const visited = new Set([run.id]);
  while (current.restartContinuationOfRunId !== undefined) {
    const source = runs.get(current.restartContinuationOfRunId);
    if (
      source === undefined ||
      visited.has(source.id) ||
      source.ordinal >= current.ordinal ||
      source.providerInstanceId !== current.providerInstanceId ||
      source.providerThreadId !== current.providerThreadId
    )
      break;
    visited.add(source.id);
    messages.push(source.userMessageId);
    current = source;
  }
  return messages;
}

const isChampionError = Schema.is(ChampionError);
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
const wordCharacter = /[\p{L}\p{N}]/u;
/** Whether `quote` appears in `text` word for word: whole words, any run of spaces alike. */
export function quotedIn(quote: string, text: string) {
  const needle = collapse(quote);
  const haystack = collapse(text);
  if (needle === "") return false;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    if (
      (before === undefined || !wordCharacter.test(before) || !wordCharacter.test(needle[0]!)) &&
      (after === undefined || !wordCharacter.test(after) || !wordCharacter.test(needle.at(-1)!))
    )
      return true;
  }
  return false;
}
/**
 * Ids of the messages Champions write into threads: check prompts, decision deliveries and the
 * Fix-with-a-lead brief. Deliveries keep client provenance so they still resume a held queue,
 * so these ids, not provenance, keep them (and those stored before T3-448) from being quoted.
 */
const CHAMPION_MESSAGE_ID_PREFIXES = ["champion:", "champion-decision:", "champion-metrics-lead:"];
/** Words a person typed into the thread; the server's, agents', automations' and guests' never count. */
const typedByPerson = (message: OrchestrationV2ConversationMessage) =>
  !CHAMPION_MESSAGE_ID_PREFIXES.some((prefix) => message.id.startsWith(prefix)) &&
  message.role === "user" &&
  message.createdBy === "user" &&
  (message.creationSource === "web" || message.creationSource === "mobile") &&
  message.scheduledTaskId === undefined &&
  message.senderThreadId === undefined &&
  message.context?.guest === undefined;
const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(Document));
const decodeCheck = Schema.decodeUnknownEffect(Schema.fromJsonString(Check));
const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(Document));
const encodeCheck = Schema.encodeEffect(Schema.fromJsonString(Check));
const encodeFinding = Schema.encodeEffect(Schema.fromJsonString(ChampionFinding));
const decodeFinding = Schema.decodeEffect(Schema.fromJsonString(ChampionFinding));
const encodeActivity = Schema.encodeEffect(Schema.fromJsonString(ChampionActivity));
const encodeMetric = Schema.encodeEffect(Schema.fromJsonString(ChampionMetric));
const decodeSummary = Schema.decodeEffect(Schema.fromJsonString(ChampionSummary));
const decodeActivity = Schema.decodeEffect(Schema.fromJsonString(ChampionActivity));
const decodeMetric = Schema.decodeEffect(Schema.fromJsonString(ChampionMetric));
const encodeCharter = Schema.encodeSync(Schema.fromJsonString(ChampionCharter));
const encodeFindings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ChampionFinding)));

type Caller = McpThreadCaller | undefined;
/** An agent completing an approval for the user: the thread it acts from and the user's words. */
export interface ChampionRelay {
  readonly threadId: ThreadId | undefined;
  readonly quote: string | undefined;
}
const JOURNEY_DEFER_MINUTES = 30;
const encodeClicks = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

type Evidence = Effect.Success<typeof ChampionEvidence.make>;
type Learnings = Effect.Success<typeof ChampionLearnings.make>;
type DetailOperation<I> = (input: I) => Effect.Effect<ChampionDetail, ChampionError>;

export class ChampionService extends Context.Service<
  ChampionService,
  {
    readonly classChoices: (
      input: ChampionClassChoicesInput,
    ) => Effect.Effect<ChampionClassChoicesResult, ChampionError>;
    readonly startInvestigationFromOwner: (
      caller: Caller,
      input: Parameters<Evidence["startInvestigation"]>[0],
    ) => ReturnType<Evidence["startInvestigation"]>;
    readonly cancelInvestigationFromOwner: (
      caller: Caller,
      input: Parameters<Evidence["cancelInvestigation"]>[0],
    ) => ReturnType<Evidence["cancelInvestigation"]>;
    readonly runtimeState: Evidence["runtimeState"];
    readonly recommendation: Evidence["recommendation"];
    readonly learningQuery: Evidence["learningQuery"];
    readonly learningSearch: Learnings["search"];
    readonly learningTopics: Learnings["topics"];
    readonly learningRead: Learnings["read"];
    /** A learning recorded by an agent other than the Champion; it counts at once. */
    readonly contributeLearning: (
      contributor: ChampionLearningContributor,
      input: ChampionLearningContributeInput,
    ) => ReturnType<Evidence["recordLearning"]>;
    readonly confirmLearning: (
      caller: Caller,
      input: ChampionLearningConfirmInput,
    ) => ReturnType<Learnings["confirm"]>;
    readonly noteLearning: (
      caller: Caller,
      input: ChampionLearningNoteInput,
    ) => ReturnType<Learnings["note"]>;
    readonly startInvestigation: Evidence["startInvestigation"];
    readonly cancelInvestigation: Evidence["cancelInvestigation"];
    readonly recordedInvestigationBinding: Evidence["recordedBinding"];
    readonly admitInvestigation: Evidence["admit"];
    readonly recordLearning: (
      caller: Caller,
      input: Parameters<Evidence["recordLearning"]>[0],
    ) => ReturnType<Evidence["recordLearning"]>;
    readonly synthesize: (
      caller: Caller,
      input: Parameters<Evidence["synthesis"]>[0],
    ) => ReturnType<Evidence["synthesis"]>;
    readonly list: (input: {
      readonly projectId?: ChampionConfig["projectId"] | undefined;
    }) => Effect.Effect<{ champions: ReadonlyArray<ChampionSummary> }, ChampionError>;
    readonly subscribe: (input: {
      readonly projectId?: ChampionConfig["projectId"] | undefined;
    }) => Stream.Stream<{ champions: ReadonlyArray<ChampionSummary> }, ChampionError>;
    readonly get: DetailOperation<{ id: string }>;
    readonly history: (
      input: typeof ChampionHistoryInput.Type,
    ) => Effect.Effect<typeof ChampionHistoryResult.Type, ChampionError>;
    readonly upsert: DetailOperation<ChampionConfig>;
    readonly setLifecycle: DetailOperation<{ id: string; lifecycle: ChampionLifecycle }>;
    readonly setup: DetailOperation<{ id: string }>;
    readonly runCheck: DetailOperation<{ id: string }>;
    /** Starts a thread on the lead role to shape and lead a fix for this champion's metrics. */
    readonly startMetricsLead: (input: {
      readonly id: string;
    }) => Effect.Effect<{ readonly threadId: ThreadId }, ChampionError>;
    readonly propose: DetailOperation<{
      id: string;
      metrics: ReadonlyArray<ChampionMetricInput>;
      reason: string;
    }>;
    /** Without `relay` the user accepts; with it an agent does, quoting the user's own words. */
    readonly accept: (
      input: ChampionAcceptInput,
      relay?: ChampionRelay,
    ) => Effect.Effect<ChampionDetail, ChampionError>;
    readonly discardProposal: DetailOperation<{ id: string }>;
    readonly cancelSetup: DetailOperation<{ id: string }>;
    readonly completeSetup: (
      caller: Caller,
      input: { summary: string },
    ) => Effect.Effect<ChampionDetail, ChampionError>;
    readonly findingAction: (
      input: typeof ChampionFindingActionInput.Type,
      actor?: "user" | ChampionRelay,
    ) => Effect.Effect<ChampionDetail, ChampionError>;
    readonly checkContext: (
      caller: Caller,
    ) => Effect.Effect<typeof ChampionCheckContext.Type, ChampionError>;
    readonly proposeFromSetup: (
      caller: Caller,
      input: ChampionProposal,
    ) => Effect.Effect<ChampionDetail, ChampionError>;
    readonly report: (
      caller: Caller,
      input: ChampionReportInput,
    ) => Effect.Effect<ChampionDetail, ChampionError>;
    readonly journeysStart: (caller: Caller) => Effect.Effect<ChampionJourneyPlan, ChampionError>;
    readonly journeyCandidate: (
      caller: Caller,
      input: ChampionJourneyCandidateInput,
    ) => Effect.Effect<{ readonly candidateId: string }, ChampionError>;
    readonly candidateReplay: (
      caller: Caller,
      input: ChampionCandidateReplayInput,
    ) => Effect.Effect<ChampionCandidateReplay, ChampionError>;
    readonly candidateSettle: (
      caller: Caller,
      input: { readonly candidateId: string },
    ) => Effect.Effect<ChampionCandidateSettled, ChampionError>;
    readonly journeyRecord: (input: {
      readonly checkId: string;
      readonly includeJourneys?: boolean | undefined;
    }) => Effect.Effect<ChampionJourneyRecordResult, ChampionError>;
    readonly updateDelivery: (
      caller: Caller,
      input: typeof ChampionFindingDeliveryInput.Type,
    ) => Effect.Effect<ChampionDetail, ChampionError>;
    readonly guardDelegation: (input: {
      ownerThreadId: ThreadId;
      request: AgentTaskRequest | undefined;
      clientRequestId: string | undefined;
      followup?: boolean | undefined;
      task?: string | undefined;
      remote?: boolean | undefined;
      childThreadId?: ThreadId | undefined;
      forgeItem?: number | string | undefined;
    }) => Effect.Effect<ModelSelection | undefined, ChampionError>;
    readonly delegationOutcome: (input: {
      ownerThreadId: ThreadId;
      request: AgentTaskRequest | undefined;
      clientRequestId: string | undefined;
      state: "started" | "finished" | "failed";
      followup?: boolean | undefined;
      commandId?: CommandId | undefined;
    }) => Effect.Effect<void, ChampionError>;
    readonly runDue: Effect.Effect<void, ChampionError>;
  }
>()("t3/champions/ChampionService") {}

function defaultStaleAfterMs(config: ChampionConfig, at: string): number {
  if (config.schedule.type === "interval") return Math.max(60_000, config.schedule.everyMs * 2);
  let previous = nextScheduledRunAt(config.schedule, DateTime.makeUnsafe(at));
  let longest = 60_000;
  for (let index = 0; index < 7 && previous !== null; index += 1) {
    const next = nextScheduledRunAt(config.schedule, previous);
    if (next === null) break;
    longest = Math.max(longest, DateTime.toEpochMillis(next) - DateTime.toEpochMillis(previous));
    previous = next;
  }
  return longest * 2;
}
function presentLatest(doc: Document, at: string): ChampionLatestSample[] {
  const cadence = defaultStaleAfterMs(doc.champion, at);
  return doc.metrics.map((metric) => {
    const sample = doc.champion.latestSamples?.find((s) => s.metricId === metric.id);
    const observed = sample?.observedAt == null ? Number.NaN : Date.parse(sample.observedAt);
    const expiration = Number.isFinite(observed)
      ? DateTime.make(observed + (metric.staleAfterMs ?? cadence))
      : Option.none();
    const staleAt = Option.isSome(expiration) ? DateTime.formatIso(expiration.value) : null;
    const value = sample?.value ?? null;
    let health: ChampionLatestSample["health"] = "unknown";
    if (sample?.seriesId === metric.seriesId && sample.version === metric.version) {
      if (sample.status === "error" || sample.status === "insufficient") health = sample.status;
      else if (Number.isFinite(observed) && staleAt !== null && at >= staleAt) health = "stale";
      else if (
        sample.status === "measured" &&
        staleAt !== null &&
        value !== null &&
        observed <= Date.parse(at) &&
        sample.collectedAt !== null &&
        observed <= Date.parse(sample.collectedAt) &&
        metric.direction !== "observe" &&
        (metric.minimum !== null || metric.maximum !== null)
      )
        health =
          (metric.minimum !== null && value < metric.minimum) ||
          (metric.maximum !== null && value > metric.maximum)
            ? "breached"
            : "healthy";
    }
    return {
      metricId: metric.id,
      name: metric.name,
      version: sample?.version ?? metric.version,
      seriesId: sample?.seriesId ?? metric.seriesId,
      unit: sample?.unit ?? metric.unit,
      required: metric.required ?? true,
      value,
      status: sample?.status ?? "unknown",
      health,
      observedAt: sample?.observedAt ?? null,
      collectedAt: sample?.collectedAt ?? null,
      revision: sample?.revision ?? null,
      staleAt,
    };
  });
}

class ChangeBatch extends Context.Reference<
  { changed: boolean; owners: Set<ThreadId> } | undefined
>("t3/champions/ChangeBatch", { defaultValue: () => undefined }) {}
const phaseForRole = (role: string) =>
  (
    {
      "implementation-worker": "implementation",
      "chore-worker": "implementation",
      "ui-worker": "implementation",
      advisor: "advice",
      reviewer: "review",
      browser: "verification",
      // Retired; a verification claimed on it before it went still completes.
      "ui-verifier": "verification",
      lead: "lead",
    } as Record<string, string>
  )[role];

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const managedAgents = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
  const projects = yield* ProjectService.ProjectService;
  const scheduler = yield* Scheduler.Scheduler;
  const landings = yield* Effect.serviceOption(SlipJayLandings.SlipJayLandings);
  const random = yield* SecureRandom.SecureRandom;
  const evidence = yield* ChampionEvidence.make;
  const learnings = yield* ChampionLearnings.make;
  const journeys = yield* ChampionJourneys.make;
  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<void>(1);
  const shellChanges = yield* PubSub.unbounded<ThreadId>();
  const failure = (cause: unknown) => new ChampionError({ reason: "unavailable", cause });
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const uuid = random.uuidV4().pipe(Effect.mapError(failure));
  const mutate = <A, R>(effect: Effect.Effect<A, ChampionError, R>) =>
    Effect.suspend(() => {
      const batch = { changed: false, owners: new Set<ThreadId>() };
      return lock.withPermits(1)(
        sql.withTransaction(effect.pipe(Effect.provideService(ChangeBatch, batch))).pipe(
          Effect.mapError((cause) => (isChampionError(cause) ? cause : failure(cause))),
          Effect.tap(() =>
            Effect.gen(function* () {
              if (batch.changed) yield* PubSub.publish(changes, undefined);
              for (const owner of batch.owners) yield* PubSub.publish(shellChanges, owner);
            }),
          ),
        ),
      );
    });

  const read = Effect.fn("ChampionService.read")(function* (id: string) {
    const rows = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champions WHERE id = ${id}`.pipe(Effect.mapError(failure));
    if (rows[0] === undefined) return yield* new ChampionError({ reason: "not-found" });
    return yield* decodeDocument(rows[0].document_json).pipe(Effect.mapError(failure));
  });
  const write = Effect.fn("ChampionService.write")(function* (doc: Document) {
    const latestSamples = presentLatest(doc, yield* now);
    const champion = {
      ...doc.champion,
      latestSamples,
      attention: [
        ...new Set([
          ...doc.champion.attention.filter(
            (a) =>
              a !== "Findings need improvement or verification." &&
              a !== "A product decision needs attention; see activity." &&
              (a !== "Required measurements are stale." || doc.champion.lifecycle === "active") &&
              a !== "A repair child failed; inspect its activity before retrying." &&
              !a.startsWith("Decision:") &&
              !a.startsWith("Repair:"),
          ),
          ...doc.findings
            .filter((f) => f.decision?.status === "requested")
            .map((f) => `Decision: ${f.title}`),
          ...doc.findings
            .filter((f) => f.repairAttention != null)
            .map((f) => `Repair: ${f.repairAttention}`),
        ]),
      ],
      pendingProposal: doc.proposal !== null,
      openFindingCount: doc.findings.filter((f) => !["verified", "dismissed"].includes(f.status))
        .length,
      updatedAt: yield* now,
    };
    const active = doc.findings.filter((f) => !["verified", "dismissed"].includes(f.status));
    const settled = doc.findings
      .filter((f) => ["verified", "dismissed"].includes(f.status))
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const finding of settled.slice(Math.max(0, 100 - active.length))) {
      const json = yield* encodeFinding(finding).pipe(Effect.mapError(failure));
      yield* sql`INSERT INTO champion_finding_archive (id,champion_id,at,document_json) VALUES (${finding.id},${champion.id},${finding.updatedAt},${json}) ON CONFLICT(id) DO UPDATE SET at=excluded.at, document_json=excluded.document_json`.pipe(
        Effect.mapError(failure),
      );
    }
    const next = {
      ...doc,
      findings: [...active, ...settled.slice(0, Math.max(0, 100 - active.length))],
      champion,
    };
    const prior = yield* sql<{
      attention: number;
    }>`SELECT json_array_length(json_extract(document_json, '$.champion.attention')) AS attention FROM champions WHERE id = ${champion.id}`.pipe(
      Effect.mapError(failure),
    );
    yield* sql`INSERT INTO champions (id, project_id, document_json) VALUES (${champion.id}, ${champion.projectId}, ${yield* encodeDocument(next).pipe(Effect.mapError(failure))})
      ON CONFLICT(id) DO UPDATE SET document_json = excluded.document_json`.pipe(
      Effect.mapError(failure),
    );
    const batch = yield* ChangeBatch;
    if (batch !== undefined) {
      batch.changed = true;
      if (
        (prior[0]?.attention !== undefined && prior[0].attention > 0) !==
        champion.attention.length > 0
      ) {
        batch.owners.add(champion.ownerThreadId);
        if (champion.setupThreadId !== null) batch.owners.add(champion.setupThreadId);
      }
    }
    return { ...next, latestSamples };
  });
  const activity = Effect.fn("ChampionService.activity")(function* (
    id: string,
    kind: string,
    text: string,
    finding?: ChampionFinding,
    threadId?: ThreadId,
    approval?: ChampionRelayedApproval,
  ) {
    const at = yield* now;
    const batch = yield* ChangeBatch;
    if (batch !== undefined) batch.changed = true;
    const entry: ChampionActivity = {
      id: `${at}:${yield* uuid}`,
      championId: id,
      at,
      kind,
      text,
      findingId: finding?.id ?? null,
      threadId: threadId ?? finding?.childThreadId ?? null,
      revision: finding?.revision ?? null,
      specUrl: finding?.specUrl ?? null,
      ...(approval === undefined ? {} : { approval }),
    };
    yield* sql`INSERT INTO champion_activity (id, champion_id, document_json) VALUES (${entry.id}, ${id}, ${yield* encodeActivity(entry).pipe(Effect.mapError(failure))})`.pipe(
      Effect.mapError(failure),
    );
  });
  const byThread = Effect.fn("ChampionService.byThread")(function* (threadId: ThreadId) {
    const rows = yield* sql<{ document_json: string }>`SELECT document_json FROM champions
      WHERE json_extract(document_json, '$.champion.ownerThreadId') = ${threadId}
      OR json_extract(document_json, '$.champion.setupThreadId') = ${threadId}`;
    return rows[0] === undefined ? undefined : yield* decodeDocument(rows[0].document_json);
  }, Effect.mapError(failure));
  const relayedApproval = Effect.fn("ChampionService.relayedApproval")(function* (
    relay: ChampionRelay,
    waiting: string,
    /** When the request was filed; an approval typed before it cannot be about it. */
    filedAt: string | undefined,
  ) {
    const ask = (why: string) =>
      new ChampionError({ reason: "unauthorized", detail: `${why} ${waiting}` });
    const quote = relay.quote?.trim() ?? "";
    if (quote === "") return yield* ask("This needs the user's approval.");
    const shell =
      relay.threadId === undefined
        ? null
        : yield* threads.getThreadShell(relay.threadId).pipe(Effect.mapError(failure));
    if (shell === null)
      return yield* ask("An approval quote counts only from a thread the user typed in.");
    const { messages } = yield* threads
      .getThreadRecords(shell.id, ["messages"], { messageRoles: ["user"] })
      .pipe(Effect.mapError(failure));
    const filed = filedAt === undefined ? undefined : DateTime.make(filedAt);
    const typed = messages.filter(
      (message) => typedByPerson(message) && quotedIn(quote, message.text),
    );
    if (typed.length === 0)
      return yield* ask(
        "That approval quote is not word for word from a message the user typed in this thread; messages T3 Code or other agents sent there do not count.",
      );
    if (
      filed !== undefined &&
      Option.isSome(filed) &&
      !typed.some((message) => !DateTime.isLessThan(message.createdAt, filed.value))
    )
      return yield* ask(
        "The user typed that before this request was filed, so it cannot approve it.",
      );
    return {
      quote,
      threadId: shell.id,
      threadTitle: shell.title.slice(0, 500),
      model: shell.modelSelection.model.slice(0, 500),
      approvedAt: yield* now,
    } satisfies ChampionRelayedApproval;
  });
  const list: ChampionService["Service"]["list"] = Effect.fn("ChampionService.list")(
    function* (input) {
      const rows =
        input.projectId === undefined
          ? yield* sql<{
              summary_json: string;
            }>`SELECT json_extract(document_json, '$.champion') AS summary_json FROM champions`.pipe(
              Effect.mapError(failure),
            )
          : yield* sql<{
              summary_json: string;
            }>`SELECT json_extract(document_json, '$.champion') AS summary_json FROM champions WHERE project_id = ${input.projectId}`.pipe(
              Effect.mapError(failure),
            );
      const at = yield* now;
      return {
        champions: yield* Effect.forEach(rows, (row) =>
          decodeSummary(row.summary_json).pipe(
            Effect.mapError(failure),
            Effect.map((summary) => ({
              ...summary,
              latestSamples: summary.latestSamples?.map((sample) =>
                sample.staleAt !== null &&
                at >= sample.staleAt &&
                (sample.health === "healthy" || sample.health === "breached")
                  ? { ...sample, health: "stale" as const }
                  : sample,
              ),
            })),
          ),
        ),
      };
    },
  );
  const validateModel = Effect.fn("ChampionService.validateModel")(function* (
    selection: ModelSelection,
  ) {
    const provider = (yield* providers.getProviders).find(
      (p) => p.instanceId === selection.instanceId,
    );
    if (
      provider === undefined ||
      provider.enabled === false ||
      provider.installed === false ||
      provider.status === "error" ||
      provider.status === "disabled" ||
      provider.availability === "unavailable" ||
      !provider.models.some((m) => m.slug === selection.model)
    )
      return yield* new ChampionError({ reason: "invalid" });
    if (isProviderUsageExhausted(provider, DateTime.toEpochMillis(yield* DateTime.now)))
      return yield* new ChampionError({ reason: "unavailable" });
    const descriptors = provider.models.find((m) => m.slug === selection.model)?.capabilities
      ?.optionDescriptors;
    if (invalidOptionSelections(selection.options ?? [], descriptors).length > 0)
      return yield* new ChampionError({ reason: "invalid" });
  });
  const nextDue = Effect.fn("ChampionService.nextDue")(function* (config: ChampionConfig) {
    const next = nextScheduledRunAt(config.schedule, yield* DateTime.now);
    return next === null ? null : DateTime.formatIso(next);
  });
  const get: ChampionService["Service"]["get"] = Effect.fn("ChampionService.get")(function* ({
    id,
  }) {
    const doc = yield* read(id);
    const latestSamples = presentLatest(doc, yield* now);
    return { ...doc, champion: { ...doc.champion, latestSamples }, latestSamples };
  });
  const resolveClasses = Effect.fn("ChampionService.resolveClasses")(function* (
    projectId: ChampionConfig["projectId"],
    taskClass: NonNullable<ChampionClassChoicesInput["taskClass"]>,
    threadId?: ThreadId | null,
  ) {
    if (Option.isNone(managedAgents)) return yield* new ChampionError({ reason: "unavailable" });
    const enabled = yield* Effect.filter(yield* providers.getProviders, (provider) =>
      threads.isProviderInstanceEnabledForProject({ projectId, instanceId: provider.instanceId }),
    );
    const owner =
      threadId == null
        ? null
        : yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failure));
    const ceiling = owner?.runtimeMode ?? "full-access";
    const result = yield* managedAgents.value
      .roles({
        projectId,
        providers: enabled,
        ceiling,
        request: { taskClass, runtimeMode: ceiling },
      })
      .pipe(Effect.mapError(failure));
    const roles = yield* Effect.forEach(result.roles, (role) =>
      role.selection === null || role.refusal !== null
        ? Effect.succeed(role)
        : validateModel(role.selection).pipe(
            Effect.as(role),
            Effect.orElseSucceed(() => ({
              ...role,
              selection: null,
              refusal: "The selected account or model is unavailable for execution.",
            })),
          ),
    );
    return { ...result, roles };
  });
  const classChoices: ChampionService["Service"]["classChoices"] = Effect.fn(
    "ChampionService.classChoices",
  )(function* (input) {
    if (Option.isNone(yield* projects.getById(input.projectId).pipe(Effect.mapError(failure))))
      return yield* new ChampionError({ reason: "not-found" });
    const doc = input.championId === undefined ? undefined : yield* read(input.championId);
    if (doc !== undefined && doc.champion.projectId !== input.projectId)
      return yield* new ChampionError({ reason: "unauthorized" });
    const threadId =
      doc === undefined
        ? undefined
        : input.phase === "setup"
          ? doc.champion.setupThreadId
          : doc.champion.ownerThreadId;
    return yield* resolveClasses(input.projectId, input.taskClass ?? "non-ui", threadId).pipe(
      Effect.map((result) => ({
        policyHash: result.policyHash,
        policyRevision: result.policyRevision,
        refusal: null,
        roles: result.roles.slice(0, 12).map((role) => ({
          role: role.role,
          selection: role.selection,
          refusal: role.refusal?.slice(0, 500) ?? null,
          ...(role.overloaded === undefined ? {} : { overloaded: role.overloaded.slice(0, 12) }),
        })),
      })),
      Effect.orElseSucceed(() => ({
        policyHash: null,
        policyRevision: null,
        refusal: "Agent class policy is unavailable on this machine.",
        roles: [],
      })),
    );
  });
  const upsert: ChampionService["Service"]["upsert"] = Effect.fn("ChampionService.upsert")(
    function* (input) {
      if (Option.isNone(yield* projects.getById(input.projectId).pipe(Effect.mapError(failure))))
        return yield* new ChampionError({ reason: "not-found" });
      // Migrated class configuration may retain historical selections that no longer exist.
      const priorConfig = yield* read(input.id).pipe(Effect.option);
      if (Option.isNone(priorConfig) && input.classes !== undefined) {
        const setup = yield* resolveClasses(input.projectId, input.classes.setup.taskClass);
        const routine =
          input.classes.routine.taskClass === input.classes.setup.taskClass
            ? setup
            : yield* resolveClasses(input.projectId, input.classes.routine.taskClass);
        const setupSelection = setup.roles.find((role) => role.role === input.classes!.setup.role);
        const routineSelection = routine.roles.find(
          (role) => role.role === input.classes!.routine.role,
        );
        if (
          setupSelection?.selection == null ||
          setupSelection.refusal !== null ||
          routineSelection?.selection == null ||
          routineSelection.refusal !== null
        )
          return yield* new ChampionError({ reason: "unavailable" });
        input = {
          ...input,
          setupModelSelection: setupSelection.selection,
          routineModelSelection: routineSelection.selection,
        };
      }
      if (
        input.classes === undefined &&
        (Option.isNone(priorConfig) || priorConfig.value.champion.classes === undefined)
      ) {
        yield* validateModel(input.setupModelSelection);
        yield* validateModel(input.routineModelSelection);
      }
      return yield* mutate(
        Effect.gen(function* () {
          const existing = yield* sql<{
            document_json: string;
          }>`SELECT document_json FROM champions WHERE id = ${input.id}`.pipe(
            Effect.mapError(failure),
          );
          const prior =
            existing[0] === undefined
              ? undefined
              : yield* decodeDocument(existing[0].document_json).pipe(Effect.mapError(failure));
          if (prior !== undefined && prior.champion.projectId !== input.projectId)
            return yield* new ChampionError({ reason: "invalid" });
          const doc: Document =
            prior === undefined
              ? {
                  champion: {
                    ...input,
                    lifecycle: "paused",
                    ownerThreadId: ThreadId.make(yield* uuid),
                    setupThreadId: null,
                    nextCheckAt: null,
                    lastCheckAt: null,
                    outstandingCheckId: null,
                    outstandingSetupId: null,
                    attention: ["Accept metric definitions before enabling checks."],
                    openFindingCount: 0,
                    pendingProposal: false,
                    updatedAt: yield* now,
                  },
                  metrics: [],
                  proposal: null,
                  findings: [],
                }
              : {
                  ...prior,
                  champion: {
                    ...prior.champion,
                    ...input,
                    classes: input.classes ?? prior.champion.classes,
                    nextCheckAt:
                      prior.champion.lifecycle === "active"
                        ? isSameSchedule(prior.champion.schedule, input.schedule)
                          ? prior.champion.nextCheckAt
                          : yield* nextDue(input)
                        : null,
                  },
                };
          const saved = yield* write(doc);
          yield* activity(
            input.id,
            "configuration",
            prior === undefined ? "Champion draft created." : "Champion configuration updated.",
          );
          return saved;
        }),
      );
    },
  );
  const setLifecycle: ChampionService["Service"]["setLifecycle"] = Effect.fn(
    "ChampionService.setLifecycle",
  )(function* (input) {
    return yield* mutate(
      Effect.gen(function* () {
        const doc = yield* read(input.id);
        if (input.lifecycle === "active" && doc.metrics.length === 0)
          return yield* new ChampionError({ reason: "invalid" });
        const saved = yield* write({
          ...doc,
          champion: {
            ...doc.champion,
            lifecycle: input.lifecycle,
            nextCheckAt: input.lifecycle === "active" ? yield* nextDue(doc.champion) : null,
          },
        });
        yield* activity(
          input.id,
          "lifecycle",
          `Champion ${input.lifecycle}. In-flight work continues.`,
        );
        return saved;
      }),
    );
  });
  const saveCheck = Effect.fn("ChampionService.saveCheck")(function* (check: Check) {
    yield* sql`INSERT INTO champion_checks (id, champion_id, thread_id, message_id, started_at, status, document_json)
      VALUES (${check.id}, ${check.championId}, ${check.threadId}, ${check.messageId}, ${check.startedAt}, ${check.cancelled ? "cancelled" : check.reported ? "reported" : "pending"}, ${yield* encodeCheck(check)})
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, message_id = excluded.message_id, document_json = excluded.document_json`;
  }, Effect.mapError(failure));
  const readCheck = Effect.fn("ChampionService.readCheck")(function* (id: string) {
    const rows = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_checks WHERE id = ${id}`.pipe(Effect.mapError(failure));
    if (!rows[0]) return yield* new ChampionError({ reason: "not-found" });
    return yield* decodeCheck(rows[0].document_json).pipe(Effect.mapError(failure));
  });
  const journeyPrompt = (doc: Document, check: Check) =>
    [
      `You own champion ${doc.champion.name} in this project. Your goal: ${doc.champion.purpose}`,
      `Check claim: ${check.id}. YOU FIND AND REPORT BUGS. YOU DO NOT REPAIR. This overrides any other instruction: no repairs, no worktrees, no source edits and no reading the target's source, even if a bug looks easy to fix.`,
      "1. Call t3_champions_check_context, then t3_champions_learning_search with this champion's id for what past checks covered. Then call t3_champions_journeys_start: it starts the target and returns its shards, the most journeys this check may run, the paths earlier checks already walked, the source files changed since, and bugs to re-test. If it says the check is deferred or refused, report that no journey ran; do not work around it.",
      "2. Choose journeys a real person might take and break: dead ends, unusual input, going back or away mid-task and losing work, double submits, empty and very long values. Prefer areas no earlier check covered and areas that recently changed; do not repeat a covered path unless it is a re-test. Never name or assume a bug you have not seen.",
      "3. Run them all at once, spread evenly across the shards. In ONE message issue one t3_browser_open per journey with url = the shard's origin + its signInPath (add next=<path> for where it starts). Then in ONE message issue one t3_browser_task per tab, each with a goal, pageReach: {} and bindings for any unusual input. Repeat in parallel batches of whole messages, never one at a time; one tab is one journey, and more tasks in the same tab continue it. The server records every journey, its clicks and its timing. Your browsers can reach only the shards. Close each tab when its journey ends.",
      "4. A journey that shows an error page, a dead end, lost work or anything a person would call broken is a candidate: call t3_champions_journey_candidate with its tabId, what should have happened and what did. That tells nobody. Do not judge whether it is real; a stronger model decides. If a journey only stalled on a limit or a slow page, it is not a candidate.",
      "5. For every candidate, and for every re-test the plan names, call t3_champions_candidate_replay. It starts a fresh database and returns workId, attemptId and a brief. Call delegate_task with agentTask {role: browser, taskClass: non-ui, readOnly: true, demanding: true, browser: {backend: integrated}, workId, attemptId, workspacePath: your workspace} and task = the brief, unchanged; any other task is refused, and so is a follow-up. At most four replays run at once: when a call says so, settle one and go on. When each finishes call t3_champions_candidate_settle: the server reads that agent's verdict itself; what you say about it does not count. Only a confirmed candidate becomes a finding.",
      "6. Retain what you covered and under which build with t3_champions_record_learning, plainSummary first.",
      "7. Call t3_champions_report with samples for each frozen metric, findings: [] (the server raises findings from confirmed candidates; never file one yourself), journeys: {started, passed, failed, stopped} counted honestly from your results, and a summary. The server compares your counts with its own and marks the check incomplete if they differ or if a shard stopped. Report plainly a check that could not finish, or that found nothing, with the paths it covered.",
      `Known findings: ${encodeFindings(doc.findings.filter((f) => f.status !== "verified" && f.status !== "dismissed"))}. Charter: ${encodeCharter(doc.champion.charter)}`,
    ].join("\n\n");
  const routinePrompt = (doc: Document, check: Check) =>
    [
      `You own champion ${doc.champion.name} in this project. Your goal: ${doc.champion.purpose}`,
      "Work towards the goal, not the metrics. Metrics are your instruments for seeing progress; when they cannot show it (blank, insufficient, or measuring the wrong thing), say so and propose a better metric with t3_champions_propose_metrics for the user to accept.",
      check.kind === "setup"
        ? 'SETUP: inspect the actual product and propose measurable metrics that show progress towards the goal with t3_champions_propose_metrics, or call t3_champions_complete_setup with a no-change summary. Name each metric in plain words someone outside engineering understands ("How long common screens take to become usable", not "Sentinel usable readiness"), and start its description with one plain sentence on what it tells the user about the goal; method detail follows. Renaming or rewording a metric keeps its series, so fix unclear names on any setup. Proposals require user acceptance. Do not edit the shared root or delegate repairs during setup.'
        : "CHECK: call t3_champions_check_context, then ask what most stands in the way of the goal right now. Collect honest observations and call t3_champions_report before finishing; its summary opens with one or two plain sentences on progress towards the goal, then the readings. Dispatch alone is not completion.",
      check.kind === "setup"
        ? null
        : `LEARNING REVIEW: call t3_champions_learning_search with championId ${doc.champion.id} and filter needs-review. For each learning another agent contributed, check it against what you know: confirm it with t3_champions_confirm_learning, or supersede it with t3_champions_record_learning (expectedCurrentId its revision) and a reason. For each learning with no plain sentence, add one with t3_champions_learning_note: one sentence someone outside engineering understands, saying what was learned.`,
      `Check claim: ${check.id}. Definitions were frozen when this check started. ${check.measureOnly ? "MEASURE ONLY: do not dispatch repairs." : "Own bounded improvements through normal delegate_task managed roles."}`,
      "Follow each frozen metric method. Copy metricId, version, unit and source verbatim from t3_champions_check_context; never paraphrase source. Put actual execution commands, paths and collection details in evidence. If collection fails, report value null with status error and explain why; never invent a numeric value.",
      "Read and measure at the project root; every writer must use an isolated workspace. Never edit the shared root. Keep this owner thread and its namespace across checks. Do not archive or replace it while children are live.",
      "For metric breaches the server creates deterministic findings. Reconcile qualitative observations with known open findings: supply existingFindingId instead of paraphrasing a duplicate. Read history on demand, never fabricate a measurement.",
      "After reporting, call t3_champions_check_context to read finding workId/attemptId. Use these exact identities in delegate_task. Bounded repair: implementation-worker or chore-worker. Large/open work: advisor on the stronger selection, shape in Forge, then lead the Spec. Use existing role policy and SlipJay. If Forge/SlipJay is unavailable, report it explicitly as attention; never claim a repair was delivered without a revision.",
      "Before a bounded investigation, call t3_champions_learning_query for its exact topic and retain the current retrieval receipt, including a legitimate empty result. Call t3_champions_start_investigation with distinct read-only hypotheses, then delegate only its returned branch workId/attemptId through normal managed roles in this project. At most three alternatives, two active branches, six admitted attempts per investigation and six per champion per rolling 24 hours; follow-ups count. Unknown launches hold capacity; replay the same identity instead of duplicating work.",
      "Call t3_champions_synthesize as the owner. Write recommendation as concise, coherent prose explaining the action, rationale, benefits, material trade-offs, uncertainty and proposed scope. Avoid labelled sections or a taxonomy; the user reads the finding issue, your recommendation and an answer field. Retain structured supporting fields for history and optional evidence expansion. Its immutable revision requests the user's decision; recheck the current revision and finding attempt before acting on an answer. Retain dated conditional learning with t3_champions_record_learning, opening with plainSummary (one plain sentence on what was learned) and including failed or inconclusive attempts and observed component versions. Due learning is uncertain and never authorizes an automatic paid rerun. Leaves return evidence; only you retain synthesis and learning.",
      "Use t3_champions_update_finding for handoff, confirmed SlipJay delivery and verification. Verification requires a comparable later measurement on the delivered/running revision. Missing evidence is inconclusive. Ordinary decisions go in the finding decision ledger and attention; keep measuring instead of blocking on questions.",
      "Write for a busy reader. Start each finding's evidence with one plain sentence naming the problem and its effect; raw numbers and commands follow. Request a decision with t3_champions_finding_action action decision: reason is the question in one line, and proposal gives action (the path you recommend, one sentence), why (one sentence) and otherOptions (each alternative in a few words with its main cost). The user can approve the proposal in one click.",
      `Delivery/review procedure: ${DEFAULT_CHAMPION_INSTRUCTIONS}. Charter: ${encodeCharter(doc.champion.charter)}. Known findings: ${encodeFindings(doc.findings.filter((f) => f.status !== "verified" && f.status !== "dismissed"))}`,
    ]
      .filter((line) => line !== null)
      .join("\n\n");
  const prompt = (doc: Document, check: Check) =>
    doc.champion.journeys !== undefined && check.kind === "check"
      ? journeyPrompt(doc, check)
      : routinePrompt(doc, check);
  const resolveAttempt = Effect.fn("ChampionService.resolveAttempt")(function* (
    doc: Document,
    check: Pick<Check, "id" | "kind" | "threadId" | "messageId" | "commandId">,
  ) {
    const selectionClass =
      doc.champion.classes?.[check.kind === "setup" ? "setup" : "routine"] ?? null;
    let resolvedSelection =
      check.kind === "setup"
        ? doc.champion.setupModelSelection
        : doc.champion.routineModelSelection;
    let policyHash: string | null = null;
    let policyRevision: string | null = null;
    if (selectionClass !== null) {
      const result = yield* resolveClasses(
        doc.champion.projectId,
        selectionClass.taskClass,
        check.threadId,
      );
      const selected = result.roles.find((role) => role.role === selectionClass.role);
      if (selected?.selection == null || selected.refusal !== null)
        return yield* new ChampionError({ reason: "unavailable" });
      resolvedSelection = selected.selection;
      policyHash = result.policyHash;
      policyRevision = result.policyRevision;
    }
    if (selectionClass !== null) yield* validateModel(resolvedSelection);
    const attempt: ChampionExecutionAttempt = {
      id: yield* uuid,
      checkId: check.id,
      kind: check.kind,
      selectionClass,
      policyHash,
      policyRevision,
      resolvedSelection,
      actualSelection: null,
      commandId: check.commandId,
      messageId: check.messageId,
      threadId: check.threadId,
      acceptedAt: yield* now,
    };
    yield* sql`INSERT INTO champion_execution_attempts (id,champion_id,check_id,at,document_json) VALUES (${attempt.id},${doc.champion.id},${check.id},${attempt.acceptedAt},${json(attempt)})`.pipe(
      Effect.mapError(failure),
    );
    return attempt;
  });
  const dispatchCheck = Effect.fn("ChampionService.dispatchCheck")(function* (check: Check) {
    const doc = yield* read(check.championId);
    if ((yield* readCheck(check.id)).cancelled) return;
    const modelSelection =
      check.executionAttempt?.resolvedSelection ??
      (check.kind === "setup"
        ? doc.champion.setupModelSelection
        : doc.champion.routineModelSelection);
    yield* validateModel(modelSelection);
    const existing = yield* threads.getThreadShell(check.threadId).pipe(Effect.mapError(failure));
    const commandId = check.commandId;
    const allowed = yield* mutate(
      Effect.gen(function* () {
        const current = yield* readCheck(check.id);
        if (current.cancelled) return false;
        yield* saveCheck({ ...current, launchStarted: true });
        return true;
      }),
    );
    if (!allowed) return;
    if (check.dispatchKind === "launch") {
      yield* launch
        .launch({
          commandId,
          threadId: check.threadId,
          projectId: doc.champion.projectId,
          title: `${check.kind === "setup" ? "Set up" : "Champion:"} ${doc.champion.name}`,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId: check.messageId, text: prompt(doc, check), attachments: [] },
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(failure));
    } else {
      if (
        existing === null ||
        existing.deletedAt !== null ||
        existing.archivedAt !== null ||
        existing.projectId !== doc.champion.projectId
      )
        return yield* new ChampionError({ reason: "conflict" });
      const provider = (yield* providers.getProviders).find(
        (p) => p.instanceId === modelSelection.instanceId,
      );
      if (
        provider !== undefined &&
        "requiresNewThreadForModelChange" in provider &&
        provider.requiresNewThreadForModelChange === true &&
        (existing.modelSelection.instanceId !== modelSelection.instanceId ||
          existing.modelSelection.model !== modelSelection.model)
      )
        return yield* new ChampionError({ reason: "conflict" });
      yield* threads
        .sendToThread({
          commandId,
          threadId: check.threadId,
          projectId: doc.champion.projectId,
          messageId: check.messageId,
          text: prompt(doc, check),
          attachments: [],
          modelSelection,
          mode: "queue",
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(failure));
    }
    if (check.kind === "check" && check.dispatchKind === "launch") {
      yield* threads
        .dispatch({
          type: "thread.compact-at.set",
          commandId: CommandId.make(`champion:${check.id}:compaction`),
          threadId: check.threadId,
          compactAt: null,
        })
        .pipe(Effect.mapError(failure));
    }
    yield* mutate(
      Effect.gen(function* () {
        const current = yield* readCheck(check.id);
        yield* saveCheck({ ...current, dispatched: true });
      }),
    );
  });
  const start = Effect.fn("ChampionService.start")(function* (
    id: string,
    kind: Check["kind"],
    scheduled = false,
    automatic = false,
  ) {
    if (kind === "check") {
      const champion = (yield* read(id)).champion;
      if (champion.journeys !== undefined) {
        const reason = journeys.overLoadLimit(champion.journeys);
        if (reason !== null) {
          if (scheduled)
            yield* mutate(
              Effect.gen(function* () {
                const doc = yield* read(id);
                yield* write({
                  ...doc,
                  champion: {
                    ...doc.champion,
                    nextCheckAt: DateTime.formatIso(
                      DateTime.add(yield* DateTime.now, { minutes: JOURNEY_DEFER_MINUTES }),
                    ) as typeof doc.champion.nextCheckAt,
                  },
                });
              }),
            );
          return yield* new ChampionError({
            reason: "conflict",
            detail: `Check deferred: ${reason}`,
          });
        }
      }
    }
    const claim = yield* mutate(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const doc = yield* read(id);
            if (
              doc.champion.lifecycle === "retired" ||
              (scheduled && doc.champion.lifecycle !== "active")
            )
              return yield* new ChampionError({ reason: "conflict" });
            const outstandingId =
              kind === "setup"
                ? (doc.champion.outstandingSetupId ?? null)
                : doc.champion.outstandingCheckId;
            if (outstandingId !== null) {
              const outstanding = yield* readCheck(outstandingId);
              if (outstanding.kind !== kind)
                return yield* new ChampionError({ reason: "conflict" });
              if (!scheduled && outstanding.dispatched) {
                const shell = yield* threads
                  .getThreadShell(outstanding.threadId)
                  .pipe(Effect.mapError(failure));
                const records =
                  shell === null
                    ? undefined
                    : yield* threads
                        .getThreadRecords(outstanding.threadId, ["runs"])
                        .pipe(Effect.mapError(failure));
                const runsById = new Map(records?.runs.map((run) => [run.id, run]));
                const acceptedPending =
                  records?.runs.some(
                    (run) =>
                      checkRunMessages(run, runsById).includes(outstanding.messageId) &&
                      !ThreadManagement.isTerminalRunStatus(run.status),
                  ) ?? false;
                const automaticRetries = (outstanding.automaticRetries ?? 0) + (automatic ? 1 : 0);
                if (
                  shell !== null &&
                  shell.activeRunId === null &&
                  !acceptedPending &&
                  shell.deletedAt === null &&
                  shell.archivedAt === null &&
                  automaticRetries <= MAX_AUTOMATIC_CHECK_RETRIES
                ) {
                  const retryId = yield* uuid;
                  let retry: Check = {
                    ...outstanding,
                    automaticRetries,
                    dispatchKind: "send",
                    dispatched: false,
                    launchStarted: false,
                    commandId: CommandId.make(`champion:${outstanding.id}:retry:${retryId}`),
                    messageId: MessageId.make(`champion:${outstanding.id}:retry:${retryId}`),
                    measureOnly: outstanding.measureOnly || doc.champion.lifecycle !== "active",
                  };
                  retry = { ...retry, executionAttempt: yield* resolveAttempt(doc, retry) };
                  yield* saveCheck(retry);
                  yield* write({
                    ...doc,
                    champion: {
                      ...doc.champion,
                      attention: doc.champion.attention.filter(
                        (attention) =>
                          !attention.startsWith(
                            `${kind === "setup" ? "Setup" : "Check"} run ended without an authenticated report.`,
                          ) &&
                          !attention.startsWith(
                            `${kind === "setup" ? "Setup" : "Check"} automatic retr`,
                          ),
                      ),
                    },
                  });
                  yield* activity(
                    id,
                    "check-retry",
                    automatic
                      ? "The provider was overloaded, so the server retried the check on its role's next eligible model. The retry retains the check definitions and owner."
                      : "The previous run ended without an authenticated report. A manual retry retains the check definitions and owner.",
                    undefined,
                    retry.threadId,
                  );
                  return retry;
                }
              }
              return outstanding;
            }
            if (kind === "check" && doc.metrics.length === 0)
              return yield* new ChampionError({ reason: "invalid" });
            const checkId = yield* uuid;
            const setupThreadId = doc.champion.setupThreadId ?? ThreadId.make(yield* uuid);
            let check: Check = {
              id: checkId,
              championId: id,
              threadId: kind === "setup" ? setupThreadId : doc.champion.ownerThreadId,
              dispatchKind:
                (yield* threads
                  .getThreadShell(kind === "setup" ? setupThreadId : doc.champion.ownerThreadId)
                  .pipe(Effect.mapError(failure))) === null
                  ? "launch"
                  : "send",
              messageId: MessageId.make(`champion:${checkId}`),
              commandId: CommandId.make(`champion:${checkId}`),
              kind,
              startedAt: yield* now,
              measureOnly: kind === "setup" || doc.champion.lifecycle !== "active",
              metrics: doc.metrics,
              reported: false,
              dispatched: false,
            };
            check = { ...check, executionAttempt: yield* resolveAttempt(doc, check) };
            yield* saveCheck(check);
            yield* write({
              ...doc,
              champion: {
                ...doc.champion,
                setupThreadId: kind === "setup" ? setupThreadId : doc.champion.setupThreadId,
                ...(kind === "setup"
                  ? { outstandingSetupId: checkId }
                  : { outstandingCheckId: checkId }),
                nextCheckAt:
                  kind === "setup"
                    ? doc.champion.nextCheckAt
                    : doc.champion.lifecycle === "active"
                      ? yield* nextDue(doc.champion)
                      : null,
              },
            });
            yield* activity(
              id,
              "check-started",
              `${kind === "setup" ? "Setup" : "Measurement"} claimed. Awaiting authenticated report.`,
              undefined,
              check.threadId,
            );
            return check;
          }),
        )
        .pipe(Effect.mapError((cause) => (isChampionError(cause) ? cause : failure(cause)))),
    ).pipe(
      Effect.tapError((error) =>
        error.reason !== "unavailable"
          ? Effect.void
          : mutate(
              Effect.gen(function* () {
                const current = yield* read(id);
                if (current.champion.classes === undefined) return;
                const note = `${kind === "setup" ? "Setup" : "Check"} class unavailable. Resolve its current policy or retry; no saved-model fallback was selected.`;
                yield* write({
                  ...current,
                  champion: {
                    ...current.champion,
                    nextCheckAt:
                      scheduled && current.champion.lifecycle === "active"
                        ? yield* nextDue(current.champion)
                        : current.champion.nextCheckAt,
                    attention: [...new Set([...current.champion.attention, note])],
                  },
                });
              }),
            ),
      ),
    );
    if (!claim.dispatched)
      yield* dispatchCheck(claim).pipe(
        Effect.catch((error) =>
          mutate(
            Effect.gen(function* () {
              const doc = yield* read(id);
              yield* write({
                ...doc,
                champion: {
                  ...doc.champion,
                  attention: [
                    ...new Set([
                      ...doc.champion.attention,
                      `${claim.kind === "setup" ? "Setup" : "Check"} dispatch unavailable. Retry uses the same durable claim and resolves its class again.`,
                    ]),
                  ],
                },
              });
              yield* activity(id, "dispatch-unavailable", error.message, undefined, claim.threadId);
            }),
          ),
        ),
      );
    return yield* read(id);
  });
  const propose: ChampionService["Service"]["propose"] = Effect.fn("ChampionService.propose")(
    function* (input) {
      return yield* mutate(
        Effect.gen(function* () {
          const doc = yield* read(input.id);
          if (
            input.metrics.length === 0 ||
            input.metrics.length > 32 ||
            new Set(input.metrics.map((m) => m.id)).size !== input.metrics.length
          )
            return yield* new ChampionError({ reason: "invalid" });
          for (const metric of input.metrics)
            if (
              metric.minimum !== null &&
              metric.maximum !== null &&
              metric.minimum > metric.maximum
            )
              return yield* new ChampionError({ reason: "invalid" });
          const saved = yield* write({
            ...doc,
            proposal: {
              id: yield* uuid,
              proposedAt: yield* now,
              metrics: input.metrics,
              reason: input.reason,
            },
            champion: {
              ...doc.champion,
              attention: [
                ...new Set([...doc.champion.attention, "Metric proposal awaits acceptance."]),
              ],
            },
          });
          yield* activity(input.id, "metric-proposal", input.reason);
          return saved;
        }),
      );
    },
  );
  const discardProposal: ChampionService["Service"]["discardProposal"] = Effect.fn(
    "ChampionService.discardProposal",
  )(function* ({ id }) {
    return yield* mutate(
      Effect.gen(function* () {
        const doc = yield* read(id);
        yield* activity(
          id,
          "proposal-discarded",
          "Discarded the pending proposal; accepted definitions are unchanged.",
        );
        return yield* write({
          ...doc,
          proposal: null,
          champion: {
            ...doc.champion,
            attention: doc.champion.attention.filter(
              (a) => a !== "Metric proposal awaits acceptance.",
            ),
          },
        });
      }),
    );
  });
  const accept: ChampionService["Service"]["accept"] = Effect.fn("ChampionService.accept")(
    function* ({ id, proposalId }, relay) {
      const pending = relay === undefined ? null : (yield* read(id)).proposal;
      if (relay !== undefined && pending !== null && pending.id === undefined)
        return yield* new ChampionError({
          reason: "conflict",
          detail:
            "This proposal was filed before proposals had ids, so it can only be accepted on the Champion page. Ask the user to accept it there, or file it again with t3_champions_propose.",
        });
      const approval =
        relay === undefined
          ? undefined
          : yield* relayedApproval(
              relay,
              "The proposal waits for them on the Champion page: ask them to accept it there, or pass approvalQuote with their exact words from a message they typed in this thread.",
              pending?.proposedAt,
            );
      return yield* mutate(
        sql
          .withTransaction(
            Effect.gen(function* () {
              const doc = yield* read(id);
              if (doc.proposal === null)
                return yield* new ChampionError({
                  reason: "conflict",
                  detail: "There is no pending metric proposal to accept.",
                });
              if (proposalId !== undefined && doc.proposal.id !== proposalId)
                return yield* new ChampionError({
                  reason: "conflict",
                  detail:
                    "The pending proposal was replaced after it was read. Read the champion again and accept the current proposal by its id.",
                });
              const metrics = yield* Effect.forEach(
                doc.proposal.metrics,
                Effect.fn("ChampionService.acceptMetric")(function* (metric) {
                  const old = doc.metrics.find((m) => m.id === metric.id);
                  const sameSeries =
                    old !== undefined &&
                    ["unit", "source", "context", "direction"].every(
                      (key) =>
                        old[key as keyof ChampionMetricInput] ===
                        metric[key as keyof ChampionMetricInput],
                    );
                  const versions = yield* sql<{
                    version: number | null;
                  }>`SELECT MAX(version) AS version FROM champion_metric_definitions WHERE champion_id = ${id} AND metric_id = ${metric.id}`.pipe(
                    Effect.mapError(failure),
                  );
                  const definition = {
                    ...metric,
                    required: metric.required ?? true,
                    baseline: metric.baseline ?? null,
                    version: (versions[0]?.version ?? 0) + 1,
                    seriesId: sameSeries ? old.seriesId : yield* uuid,
                    reason: doc.proposal!.reason,
                  };
                  const at = yield* now;
                  const json = yield* encodeMetric(definition).pipe(Effect.mapError(failure));
                  yield* sql`INSERT INTO champion_metric_definitions (champion_id, metric_id, version, created_at, document_json) VALUES (${id}, ${metric.id}, ${definition.version}, ${at}, ${json})`.pipe(
                    Effect.mapError(failure),
                  );
                  return definition;
                }),
              );
              const saved = yield* write({
                ...doc,
                metrics,
                proposal: null,
                champion: {
                  ...doc.champion,
                  attention: doc.champion.attention.filter(
                    (a) =>
                      a !== "Metric proposal awaits acceptance." &&
                      a !== "Accept metric definitions before enabling checks.",
                  ),
                },
              });
              yield* activity(
                id,
                "metrics-accepted",
                doc.proposal.reason,
                undefined,
                approval?.threadId,
                approval,
              );
              return saved;
            }),
          )
          .pipe(Effect.mapError((cause) => (isChampionError(cause) ? cause : failure(cause)))),
      );
    },
  );
  const authenticateLive = Effect.fn("ChampionService.authenticateLive")(function* (
    caller: Caller,
  ) {
    if (caller === undefined) return yield* new ChampionError({ reason: "unauthorized" });
    const credential = yield* mcpSessions.read(caller.threadId);
    if (
      credential === undefined ||
      credential.providerSessionId !== caller.providerSessionId ||
      credential.providerInstanceId !== caller.providerInstanceId
    )
      return yield* new ChampionError({ reason: "unauthorized" });
    const shell = yield* threads.getThreadShell(caller.threadId).pipe(Effect.mapError(failure));
    if (
      shell === null ||
      shell.activeRunId === null ||
      shell.archivedAt !== null ||
      shell.deletedAt !== null
    )
      return yield* new ChampionError({ reason: "unauthorized" });
    const records = yield* threads
      .getThreadRecords(caller.threadId, ["runs", "providerThreads"])
      .pipe(Effect.mapError(failure));
    const run = records.runs.find(
      (r) => r.id === shell.activeRunId && r.providerInstanceId === caller.providerInstanceId,
    );
    const providerThread = records.providerThreads.find(
      (p) => p.id === shell.activeProviderThreadId,
    );
    if (
      run === undefined ||
      !ThreadManagement.isActiveRun(run) ||
      providerThread === undefined ||
      run.providerThreadId !== providerThread.id
    )
      return yield* new ChampionError({ reason: "unauthorized" });
    return { shell, run, runs: records.runs };
  });
  const authenticate = Effect.fn("ChampionService.authenticateCheck")(function* (caller: Caller) {
    const { shell, run, runs } = yield* authenticateLive(caller);
    const runsById = new Map(runs.map((candidate) => [candidate.id, candidate]));
    const rows = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_checks WHERE thread_id = ${shell.id} AND message_id IN ${sql.in(checkRunMessages(run, runsById))}`.pipe(
      Effect.mapError(failure),
    );
    if (!rows[0]) return yield* new ChampionError({ reason: "unauthorized" });
    const check = yield* decodeCheck(rows[0].document_json).pipe(Effect.mapError(failure));
    if (check.cancelled) return yield* new ChampionError({ reason: "conflict" });
    const doc = yield* read(check.championId);
    if (doc.champion.projectId !== shell.projectId)
      return yield* new ChampionError({ reason: "unauthorized" });
    if (check.executionAttempt !== undefined && !check.reported) {
      const attempt = { ...check.executionAttempt, actualSelection: run.modelSelection };
      yield* sql`UPDATE champion_execution_attempts SET document_json = ${json(attempt)} WHERE id = ${attempt.id}`.pipe(
        Effect.mapError(failure),
      );
    }
    return { check, doc, run };
  });
  const checkContext: ChampionService["Service"]["checkContext"] = Effect.fn(
    "ChampionService.checkContext",
  )(function* (caller) {
    const { check, doc } = yield* authenticate(caller);
    return {
      champion: doc,
      checkId: check.id,
      messageId: check.messageId,
      metrics: check.metrics,
      measureOnly: check.measureOnly || doc.champion.lifecycle !== "active",
    };
  });
  const proposeFromSetup: ChampionService["Service"]["proposeFromSetup"] = Effect.fn(
    "ChampionService.proposeFromSetup",
  )(function* (caller, input) {
    const { check } = yield* authenticate(caller);
    const result = yield* propose({ id: check.championId, ...input });
    // A routine check still owes its report; only setup ends with its proposal.
    if (check.kind === "check") return result;
    yield* mutate(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* readCheck(check.id);
            if (current.reported) return;
            yield* saveCheck({ ...current, reported: true });
            const doc = yield* read(check.championId);
            yield* write({
              ...doc,
              champion: {
                ...doc.champion,
                outstandingSetupId: null,
                attention: doc.champion.attention.filter((a) => !a.startsWith("Setup ")),
              },
            });
          }),
        )
        .pipe(Effect.mapError((cause) => (isChampionError(cause) ? cause : failure(cause)))),
    );
    return { ...result, champion: { ...result.champion, outstandingSetupId: null } };
  });
  const completeSetup: ChampionService["Service"]["completeSetup"] = Effect.fn(
    "ChampionService.completeSetup",
  )(function* (caller, input) {
    return yield* mutate(
      Effect.gen(function* () {
        const { doc, check } = yield* authenticate(caller);
        if (check.kind !== "setup") return yield* new ChampionError({ reason: "unauthorized" });
        if (check.reported) return doc;
        yield* saveCheck({ ...check, reported: true });
        yield* activity(
          doc.champion.id,
          "setup-completed",
          input.summary,
          undefined,
          check.threadId,
        );
        return yield* write({
          ...doc,
          champion: {
            ...doc.champion,
            outstandingSetupId: null,
            attention: doc.champion.attention.filter((a) => !a.startsWith("Setup ")),
          },
        });
      }),
    );
  });
  const cancelSetup: ChampionService["Service"]["cancelSetup"] = Effect.fn(
    "ChampionService.cancelSetup",
  )(function* ({ id }) {
    const doc = yield* read(id);
    const pending = doc.champion.outstandingSetupId;
    if (!pending) return doc;
    const check = yield* readCheck(pending);
    const shell = yield* threads.getThreadShell(check.threadId).pipe(Effect.mapError(failure));

    if (shell !== null)
      yield* threads
        .dispatch({
          type: "thread.stop",
          threadId: check.threadId,
          commandId: CommandId.make(`champion-cancel-setup:${check.id}`),
          stopDelegatedTasks: false,
        })
        .pipe(Effect.mapError(failure));
    return yield* mutate(
      Effect.gen(function* () {
        const current = yield* read(id);
        if (current.champion.outstandingSetupId !== check.id) return current;
        const latest = yield* readCheck(check.id);
        if (shell === null && latest.launchStarted) {
          const receipt = yield* threads
            .getReceipt(latest.commandId)
            .pipe(Effect.mapError(failure));
          if (Option.isNone(receipt) || receipt.value.status !== "rejected")
            return yield* new ChampionError({ reason: "conflict" });
        }
        yield* saveCheck({ ...latest, cancelled: true });
        yield* activity(
          id,
          "setup-cancelled",
          "The user cancelled setup through the normal thread stop command.",
          undefined,
          check.threadId,
        );
        return yield* write({
          ...current,
          champion: {
            ...current.champion,
            outstandingSetupId: null,
            attention: current.champion.attention.filter((a) => !a.startsWith("Setup ")),
          },
        });
      }),
    );
  });
  const makeFinding = Effect.fn("ChampionService.makeFinding")(function* (
    id: string,
    title: string,
    evidence: string,
    metric?: ChampionMetric,
    sample?: ChampionSampleInput,
  ) {
    const findingId =
      metric === undefined ? `${id}:qualitative:${yield* uuid}` : `${id}:metric:${metric.seriesId}`;
    return {
      id: findingId,
      title,
      evidence,
      baselineValue: sample?.value ?? null,
      baselineMetric: metric ?? null,
      deliveredAt: null,
      metricId: metric?.id ?? null,
      seriesId: metric?.seriesId ?? null,
      status: "open" as const,
      childThreadId: null,
      workId: `champion:${findingId}`,
      attemptId: `${findingId}:1`,
      revision: null,
      specUrl: null,
      updatedAt: yield* now,
    };
  });
  const similar = (a: string, b: string) => {
    const ignored = new Set([
      "the",
      "a",
      "an",
      "is",
      "are",
      "was",
      "were",
      "and",
      "to",
      "of",
      "in",
      "for",
      "on",
    ]);
    const words = (text: string) =>
      new Set((text.toLowerCase().match(/[a-z0-9_-]+/g) ?? []).filter((w) => !ignored.has(w)));
    const left = words(a),
      right = words(b);
    return left.size > 0 && left.size === right.size && [...left].every((w) => right.has(w));
  };
  const report: ChampionService["Service"]["report"] = Effect.fn("ChampionService.report")(
    function* (caller, input) {
      const journeyCheck = yield* authenticate(caller).pipe(
        Effect.flatMap(({ check, doc }) => {
          const config = doc.champion.journeys;
          if (config === undefined || check.kind !== "check" || check.reported)
            return Effect.undefined;
          if (input.findings.length > 0)
            return Effect.fail(
              new ChampionError({
                reason: "invalid",
                detail:
                  "A journey check raises findings only from confirmed candidates. Send findings: [] and file candidates instead.",
              }),
            );
          return journeys.finish({
            checkId: check.id,
            championId: doc.champion.id,
            threadId: check.threadId,
            config,
            owner: input.journeys,
          });
        }),
      );
      return yield* mutate(
        sql
          .withTransaction(
            Effect.gen(function* () {
              const { check, doc, run } = yield* authenticate(caller);
              if (check.kind !== "check")
                return yield* new ChampionError({ reason: "unauthorized" });
              if (check.reported) return doc;
              const collectedAt = yield* now;
              if (new Set(input.samples.map((s) => s.metricId)).size !== input.samples.length)
                return yield* new ChampionError({
                  reason: "invalid",
                  validation: { field: "samples" },
                });
              const samples: ChampionSample[] = [];
              const findings = [...doc.findings];
              let findingsLimited = false;
              for (const [sampleIndex, sample] of input.samples.entries()) {
                const metric = check.metrics.find((m) => m.id === sample.metricId);
                if (metric === undefined)
                  return yield* new ChampionError({
                    reason: "invalid",
                    validation: { sampleIndex, field: "metricId" },
                  });
                const field =
                  metric.version !== sample.version
                    ? "version"
                    : metric.unit !== sample.unit
                      ? "unit"
                      : sample.status === "measured" && metric.source !== sample.source
                        ? "source"
                        : (sample.status === "measured") !== (sample.value !== null) ||
                            (sample.value !== null && !Number.isFinite(sample.value))
                          ? "value"
                          : !Number.isFinite(Date.parse(sample.observedAt))
                            ? "observedAt"
                            : undefined;
                if (field !== undefined)
                  return yield* new ChampionError({
                    reason: "invalid",
                    validation: { sampleIndex, field },
                  });
                samples.push({
                  ...sample,
                  championId: check.championId,
                  checkId: check.id,
                  seriesId: metric.seriesId,
                  collectedAt,
                  threadId: check.threadId,
                  runId: run.id,
                  modelSelection: run.modelSelection,
                  provenance: "agent-reported",
                });
                const breached =
                  sample.value !== null &&
                  metric.direction !== "observe" &&
                  ((metric.minimum !== null && sample.value < metric.minimum) ||
                    (metric.maximum !== null && sample.value > metric.maximum));
                if (breached) {
                  const existing = findings.find(
                    (f) => f.id === `${check.championId}:metric:${metric.seriesId}`,
                  );
                  if (existing === undefined) {
                    if (
                      findings.filter((f) => !["verified", "dismissed"].includes(f.status))
                        .length >= 50
                    )
                      findingsLimited = true;
                    else
                      findings.push(
                        yield* makeFinding(
                          check.championId,
                          `${metric.name} is outside its target`,
                          sample.evidence,
                          metric,
                          sample,
                        ),
                      );
                  } else if (existing.status === "verified" || existing.status === "dismissed") {
                    const index = findings.indexOf(existing);
                    findings[index] = {
                      ...existing,
                      status: "open",
                      evidence: sample.evidence,
                      updatedAt: collectedAt,
                      attemptId: `${existing.id}:${check.id}`,
                      baselineValue: sample.value,
                      baselineMetric: metric,
                      deliveredAt: null,
                      childThreadId: null,
                      revision: null,
                    };
                  }
                }
              }
              if (
                check.metrics.some(
                  (metric) =>
                    (metric.required ?? true) && !samples.some((s) => s.metricId === metric.id),
                )
              )
                return yield* new ChampionError({
                  reason: "invalid",
                  validation: { field: "samples" },
                });
              for (const qualitative of input.findings) {
                const existing =
                  qualitative.existingFindingId === undefined
                    ? findings.find(
                        (f) =>
                          !["verified", "dismissed"].includes(f.status) &&
                          similar(f.title, qualitative.title),
                      )
                    : findings.find(
                        (f) =>
                          f.id === qualitative.existingFindingId &&
                          !["verified", "dismissed"].includes(f.status),
                      );
                if (qualitative.existingFindingId !== undefined && existing === undefined)
                  return yield* new ChampionError({ reason: "invalid" });
                if (existing !== undefined) {
                  findings[findings.indexOf(existing)] = {
                    ...existing,
                    evidence: qualitative.evidence,
                    updatedAt: collectedAt,
                  };
                } else {
                  if (
                    findings.filter((f) => !["verified", "dismissed"].includes(f.status)).length >=
                    50
                  ) {
                    findingsLimited = true;
                    continue;
                  }
                  findings.push(
                    yield* makeFinding(check.championId, qualitative.title, qualitative.evidence),
                  );
                }
              }
              yield* saveCheck({ ...check, reported: true, samples });
              const attention = [
                ...(journeyCheck?.status === "incomplete"
                  ? [`The last journey check did not finish: ${journeyCheck.reason}`]
                  : []),
                ...(findingsLimited
                  ? ["Open finding limit reached. Reconcile existing findings before opening more."]
                  : []),
                ...(doc.proposal === null ? [] : ["Metric proposal awaits acceptance."]),

                ...(samples.some(
                  (s) =>
                    s.status !== "measured" &&
                    (check.metrics.find((m) => m.id === s.metricId)?.required ?? true),
                )
                  ? ["Some measurements are unknown, insufficient, or failed."]
                  : []),
              ];
              const saved = yield* write({
                ...doc,
                findings,
                champion: {
                  ...doc.champion,
                  outstandingCheckId: null,
                  latestSamples: [
                    ...(doc.champion.latestSamples ?? []).filter(
                      (old) => !samples.some((sample) => sample.metricId === old.metricId),
                    ),
                    ...samples.map((sample) => ({
                      metricId: sample.metricId,
                      name: check.metrics.find((m) => m.id === sample.metricId)!.name,
                      version: sample.version,
                      seriesId: sample.seriesId,
                      unit: sample.unit,
                      required:
                        check.metrics.find((m) => m.id === sample.metricId)?.required ?? true,
                      value: sample.value,
                      status: sample.status,
                      health: "unknown" as const,
                      observedAt: sample.observedAt,
                      collectedAt: sample.collectedAt,
                      revision: sample.revision,
                      staleAt: null,
                    })),
                  ],
                  lastCheckAt: collectedAt,
                  attention,
                },
              });
              yield* activity(
                check.championId,
                "check-reported",
                input.summary,
                undefined,
                check.threadId,
              );
              for (const finding of findings.filter(
                (f) => !doc.findings.some((old) => old.id === f.id),
              ))
                yield* activity(check.championId, "finding-opened", finding.evidence, finding);
              return saved;
            }),
          )
          .pipe(Effect.mapError((cause) => (isChampionError(cause) ? cause : failure(cause)))),
      );
    },
  );
  const deliverDecision = Effect.fn("ChampionService.deliverDecision")(function* (id: string) {
    const rows = yield* sql<{
      id: string;
      champion_id: string;
      finding_id: string;
      answer: string;
    }>`SELECT * FROM champion_decision_deliveries WHERE id = ${id} AND delivered = 0`.pipe(
      Effect.mapError(failure),
    );
    const row = rows[0];
    if (row === undefined) return;
    const doc = yield* read(row.champion_id);
    const decision = doc.findings.find((finding) => finding.id === row.finding_id)?.decision;
    if (
      decision?.id !== row.id ||
      (decision.findingAttemptId !== undefined &&
        doc.findings.find((finding) => finding.id === row.finding_id)?.attemptId !==
          decision.findingAttemptId)
    ) {
      yield* sql`UPDATE champion_decision_deliveries SET delivered = 1 WHERE id = ${id}`.pipe(
        Effect.mapError(failure),
      );
      return;
    }
    if (decision.recommendationId !== undefined)
      yield* evidence.getRecommendation(decision.recommendationId);
    yield* threads
      .sendToThread({
        projectId: doc.champion.projectId,
        threadId: doc.champion.ownerThreadId,
        commandId: CommandId.make(`champion-decision:${row.id}`),
        messageId: MessageId.make(`champion-decision:${row.id}`),
        text: `${
          decision.approval === undefined
            ? ""
            : `This answer was relayed by an agent in thread ${decision.approval.threadId} ("${decision.approval.threadTitle}"), not given on the Champion page; the user's words there: "${decision.approval.quote}". `
        }The user resolved decision ${row.id} for finding ${row.finding_id}. Recommendation ${decision.recommendationId ?? "legacy decision"}; finding attempt ${decision.findingAttemptId ?? "legacy attempt"}; authorized proposed scope: ${decision.proposedScope ?? "the recorded question"}. Recheck the current finding and recommendation before using this answer; supersession invalidates it. Preserve charter, design, review and release authority and continue unrelated measurements.\n${row.answer}`,
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError(failure));
    yield* mutate(
      Effect.gen(function* () {
        yield* sql`UPDATE champion_decision_deliveries SET delivered = 1 WHERE id = ${id}`.pipe(
          Effect.mapError(failure),
        );
        const current = yield* read(row.champion_id);
        yield* write({
          ...current,
          champion: {
            ...current.champion,
            attention: current.champion.attention.filter(
              (a) => a !== `Decision answer delivery pending: ${id}`,
            ),
          },
        });
      }),
    );
  });
  const startMetricsLead: ChampionService["Service"]["startMetricsLead"] = Effect.fn(
    "ChampionService.startMetricsLead",
  )(function* (input) {
    const doc = yield* read(input.id);
    if (doc.champion.lifecycle === "retired")
      return yield* new ChampionError({
        reason: "conflict",
        detail: "This champion is retired. Restore it before starting a lead on its metrics.",
      });
    const result = yield* resolveClasses(doc.champion.projectId, "non-ui");
    const lead = result.roles.find((role) => role.role === "lead");
    if (lead?.selection == null || lead.refusal !== null)
      return yield* new ChampionError({
        reason: "unavailable",
        detail: "No model is available for the lead role, so nothing was started.",
      });
    const key = yield* uuid;
    const threadId = ThreadId.make(key);
    const latest = presentLatest(doc, yield* now);
    const metricLines = doc.metrics.map((metric) => {
      const sample = latest.find((entry) => entry.metricId === metric.id);
      const reading =
        sample === undefined
          ? "never measured"
          : `${sample.status}, value ${sample.value ?? "none"}`;
      return `- ${metric.name} (${metric.id}): ${metric.description || "no description"} Latest: ${reading}.`;
    });
    const problems = [
      ...doc.champion.attention.filter((line) => !line.startsWith("Decision: ")),
      ...doc.findings
        .filter((finding) => !["verified", "dismissed"].includes(finding.status))
        .map((finding) => `Open finding: ${finding.title}`),
    ];
    yield* launch
      .launch({
        commandId: CommandId.make(`champion-metrics-lead:${key}`),
        threadId,
        projectId: doc.champion.projectId,
        title: `Fix metrics: ${doc.champion.name}`,
        modelSelection: lead.selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make(`champion-metrics-lead:${key}`),
          text: [
            `The user asked you to fix the metrics of the ${doc.champion.name} champion (id ${doc.champion.id}). Its goal: ${doc.champion.purpose}`,
            `Its metrics now:\n${metricLines.join("\n") || "- none"}`,
            `What looks wrong:\n${problems.map((line) => `- ${line}`).join("\n") || "- nothing recorded; judge from the metrics above"}`,
            "Work out which metrics fail to show honest progress towards the goal: ones that cannot be collected here, that measure the wrong thing, or whose names a non-engineer would not understand. Shape the fix as a Spec with the shape skill and lead it with the lead skill. Read current state with t3_champions_get. Give new or changed definitions to the champion with t3_champions_propose; the user accepts them on its page, and renaming keeps a metric's history. Do not change the champion's checks or findings directly.",
          ].join("\n\n"),
          attachments: [],
        },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError(failure));
    yield* mutate(
      activity(
        doc.champion.id,
        "metrics-lead",
        "Started a lead to fix these metrics.",
        undefined,
        threadId,
      ),
    );
    return { threadId };
  });
  const findingAction: ChampionService["Service"]["findingAction"] = Effect.fn(
    "ChampionService.findingAction",
  )(function* (input, actor = "user") {
    const approval =
      input.action !== "resolve_decision" || actor === "user"
        ? undefined
        : yield* relayedApproval(
            actor,
            "The decision waits for them on the Champion page: ask them to answer it there, or pass approvalQuote with their exact words from a message they typed in this thread.",
            (yield* read(input.id)).findings.find((f) => f.id === input.findingId)?.decision
              ?.requestedAt,
          );
    const result = yield* mutate(
      Effect.gen(function* () {
        const doc = yield* read(input.id);
        const finding = doc.findings.find((f) => f.id === input.findingId);
        if (finding === undefined) return yield* new ChampionError({ reason: "not-found" });
        if (["dismiss", "reopen"].includes(input.action)) {
          if (yield* evidence.hasLive(input.id, input.findingId))
            return yield* new ChampionError({ reason: "conflict" });
          const claims = yield* sql<{
            phase: string;
            state: string;
          }>`SELECT phase,state FROM champion_repair_claims WHERE work_id = ${finding.workId} AND attempt_id = ${finding.attemptId} AND state IN ('reserved','unknown','accepted')`.pipe(
            Effect.mapError(failure),
          );
          for (const claim of claims) {
            const proof = yield* acceptedChild(doc, finding, claim.phase).pipe(Effect.option);
            if (
              Option.isNone(proof) ||
              !["completed", "failed", "cancelled", "interrupted"].includes(proof.value.task.status)
            )
              return yield* new ChampionError({ reason: "conflict" });
            yield* sql`UPDATE champion_repair_claims SET state = 'completed' WHERE work_id = ${finding.workId} AND attempt_id = ${finding.attemptId} AND phase = ${claim.phase}`.pipe(
              Effect.mapError(failure),
            );
          }
        }
        const at = yield* now;
        let updated: ChampionFinding = { ...finding, updatedAt: at };
        if (input.action === "decision") {
          const recommendation =
            input.recommendationId === undefined
              ? undefined
              : yield* evidence.getRecommendation(input.recommendationId);
          if (
            recommendation !== undefined &&
            (recommendation.id !== input.id ||
              recommendation.findingId !== finding.id ||
              recommendation.findingAttemptId !== finding.attemptId)
          )
            return yield* new ChampionError({ reason: "conflict" });
          if (
            finding.decision != null &&
            (finding.decision.status === "requested" || recommendation !== undefined) &&
            finding.decision.recommendationId === input.recommendationId &&
            finding.decision.findingAttemptId === recommendation?.findingAttemptId
          )
            return doc;
          updated = {
            ...updated,
            decision: {
              id: yield* uuid,
              question: input.reason,
              ...(input.proposal === undefined ? {} : { proposal: input.proposal }),
              ...(recommendation === undefined
                ? {}
                : {
                    recommendationId: recommendation.recommendationId,
                    findingAttemptId: recommendation.findingAttemptId,
                    proposedScope: recommendation.proposedScope,
                  }),
              status: "requested",
              answer: null,
              requestedAt: at,
              resolvedAt: null,
            },
          };
        } else if (input.action === "resolve_decision") {
          if (!input.decisionId || finding.decision?.id !== input.decisionId)
            return yield* new ChampionError({
              reason: "conflict",
              detail:
                "That decision is not the finding's current one. Read the champion again and answer the decision it shows by its id.",
            });
          if (finding.decision.recommendationId !== undefined) {
            const recommendation = yield* evidence.getRecommendation(
              finding.decision.recommendationId,
            );
            if (
              recommendation.findingAttemptId !== finding.attemptId ||
              finding.decision.findingAttemptId !== finding.attemptId ||
              recommendation.proposedScope !== finding.decision.proposedScope
            )
              return yield* new ChampionError({
                reason: "conflict",
                detail:
                  "The finding or its recommendation changed after this decision was requested, so it can no longer be answered.",
              });
          }
          if (finding.decision.status === "resolved") {
            if (finding.decision.answer !== input.reason)
              return yield* new ChampionError({
                reason: "conflict",
                detail: "This decision was already answered differently.",
              });
            return doc;
          }
          updated = {
            ...updated,
            decision: {
              ...finding.decision,
              status: "resolved",
              answer: input.reason,
              ...(approval === undefined ? {} : { approval }),
              resolvedAt: at,
            },
          };
          yield* sql`INSERT INTO champion_decision_deliveries (id,champion_id,finding_id,answer) VALUES (${input.decisionId},${input.id},${finding.id},${input.reason})`.pipe(
            Effect.mapError(failure),
          );
        } else
          updated = {
            ...updated,
            status: input.action === "dismiss" ? "dismissed" : "open",
            repairAttention: null,
            decision: null,
            ...(input.action === "reopen"
              ? {
                  attemptId: `${finding.id}:${yield* uuid}`,
                  childThreadId: null,
                  revision: null,
                  deliveredAt: null,
                  delivery: null,
                }
              : {}),
          };
        yield* activity(
          input.id,
          input.action,
          input.reason,
          updated,
          approval?.threadId,
          approval,
        );
        return yield* write({
          ...doc,
          findings: doc.findings.map((f) => (f.id === updated.id ? updated : f)),
        });
      }),
    );
    if (input.action === "resolve_decision" && input.decisionId !== undefined) {
      yield* deliverDecision(input.decisionId).pipe(
        Effect.catch(() =>
          mutate(
            Effect.gen(function* () {
              const doc = yield* read(input.id);
              yield* write({
                ...doc,
                champion: {
                  ...doc.champion,
                  attention: [
                    ...new Set([
                      ...doc.champion.attention,
                      `Decision answer delivery pending: ${input.decisionId}`,
                    ]),
                  ],
                },
              });
            }),
          ),
        ),
      );
      return yield* read(input.id);
    }
    return result;
  });
  const acceptedChild = Effect.fn("ChampionService.acceptedChild")(function* (
    doc: Document,
    finding: ChampionFinding,
    phase = finding.specUrl === null ? "implementation" : "lead",
  ) {
    const records = yield* threads
      .getThreadRecords(doc.champion.ownerThreadId, ["subagents"])
      .pipe(Effect.mapError(failure));
    const newest = records.subagents
      .toReversed()
      .toSorted(
        (left, right) =>
          (right.updatedAt === undefined ? 0 : DateTime.toEpochMillis(right.updatedAt)) -
          (left.updatedAt === undefined ? 0 : DateTime.toEpochMillis(left.updatedAt)),
      );
    for (const task of newest) {
      if (task.origin !== "app_owned" || task.childThreadId === null) continue;
      const shell = yield* threads
        .getThreadShell(task.childThreadId)
        .pipe(Effect.mapError(failure));
      if (
        shell?.activeRunId != null &&
        ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
      )
        continue;
      if (
        shell?.agentTask?.workId === finding.workId &&
        shell.agentTask.attemptId === finding.attemptId &&
        phaseForRole(shell.agentTask.role) === phase &&
        shell.projectId === doc.champion.projectId
      )
        return { task, shell };
    }
    return yield* new ChampionError({ reason: "conflict" });
  });
  const updateDelivery: ChampionService["Service"]["updateDelivery"] = Effect.fn(
    "ChampionService.updateDelivery",
  )(function* (caller, input) {
    const { shell } = yield* authenticateLive(caller);
    const ownerDoc = yield* byThread(shell.id);
    const summary = ownerDoc?.champion;
    if (summary === undefined || summary.ownerThreadId !== shell.id)
      return yield* new ChampionError({ reason: "unauthorized" });
    const evidence =
      input.action === "delivered"
        ? yield* Effect.gen(function* () {
            const doc = yield* read(summary.id);
            const finding = doc.findings.find((f) => f.id === input.findingId);
            if (!finding) return yield* new ChampionError({ reason: "not-found" });
            if (
              finding.status !== "handed_back" ||
              !input.operationId ||
              !input.revision ||
              Option.isNone(landings)
            )
              return yield* new ChampionError({ reason: "invalid" });
            const project = yield* projects
              .getById(summary.projectId)
              .pipe(Effect.mapError(failure));
            if (Option.isNone(project)) return yield* new ChampionError({ reason: "not-found" });
            const repository = yield* landings.value.repositoryOf(project.value.workspaceRoot);
            if (repository === null) return yield* new ChampionError({ reason: "unavailable" });
            const outcome = yield* landings.value
              .readDetail({ cwd: project.value.workspaceRoot, operationId: input.operationId })
              .pipe(Effect.mapError(failure));
            if (
              !outcome.terminal ||
              outcome.status !== "landed" ||
              outcome.commitId !== input.revision ||
              !outcome.finishedAt ||
              !Number.isFinite(Date.parse(outcome.finishedAt))
            )
              return yield* new ChampionError({ reason: "conflict" });
            return {
              finding,
              outcome: { ...outcome, commitId: outcome.commitId, finishedAt: outcome.finishedAt },
            };
          })
        : undefined;
    return yield* mutate(
      Effect.gen(function* () {
        const doc = yield* read(summary.id);
        const finding = doc.findings.find((f) => f.id === input.findingId);
        if (!finding) return yield* new ChampionError({ reason: "not-found" });
        const at = yield* now;
        let updated: ChampionFinding = { ...finding, updatedAt: at };
        if (input.action === "handed_back") {
          const { task, shell: child } = yield* acceptedChild(doc, finding);
          if (
            task.status !== "completed" ||
            child.activeRunId != null ||
            !input.revision ||
            !task.result?.includes(input.revision)
          )
            return yield* new ChampionError({ reason: "conflict" });
          updated = {
            ...updated,
            status: "handed_back",
            childThreadId: task.childThreadId,
            revision: input.revision,
            deliveredAt: null,
            delivery: null,
          };
        } else if (input.action === "delivered") {
          if (
            finding.status !== "handed_back" ||
            !input.operationId ||
            !input.revision ||
            Option.isNone(landings)
          )
            return yield* new ChampionError({ reason: "invalid" });
          if (
            evidence === undefined ||
            doc.champion.ownerThreadId !== shell.id ||
            doc.champion.projectId !== summary.projectId ||
            !sameFinding(finding, evidence.finding)
          )
            return yield* new ChampionError({ reason: "conflict" });
          const { outcome } = evidence;
          updated = {
            ...updated,
            status: "delivered",
            revision: outcome.commitId,
            deliveredAt: DateTime.formatIso(DateTime.makeUnsafe(outcome.finishedAt)),
            delivery: {
              operationId: input.operationId,
              revision: outcome.commitId,
              confirmedAt: at,
              provenance: "slipjay-runner",
            },
          };
        } else if (input.action === "verify") {
          if (
            !["delivered", "inconclusive"].includes(finding.status) ||
            finding.revision === null ||
            finding.seriesId === null ||
            finding.delivery?.revision !== finding.revision
          )
            return yield* new ChampionError({ reason: "invalid" });
          const historyRows = yield* sql<{
            document_json: string;
          }>`SELECT document_json FROM champion_checks WHERE champion_id = ${doc.champion.id} AND status = 'reported' AND started_at >= ${finding.deliveredAt ?? finding.updatedAt} ORDER BY started_at DESC, rowid DESC LIMIT 100`.pipe(
            Effect.mapError(failure),
          );
          const checks = yield* Effect.forEach(historyRows, (row) =>
            decodeCheck(row.document_json).pipe(Effect.mapError(failure)),
          );
          const baseline = finding.baselineMetric;
          const baselineValue = finding.baselineValue;
          const comparable = checks
            .flatMap((c) => c.samples ?? [])
            .find(
              (s) =>
                baseline != null &&
                baselineValue != null &&
                s.seriesId === finding.seriesId &&
                s.unit === baseline.unit &&
                s.source === baseline.source &&
                s.revision === finding.revision &&
                s.status === "measured" &&
                s.value !== null &&
                s.collectedAt > (finding.deliveredAt ?? finding.updatedAt) &&
                Date.parse(s.observedAt) > Date.parse(finding.deliveredAt ?? finding.updatedAt) &&
                Date.parse(s.observedAt) <= Date.parse(s.collectedAt) &&
                (baseline.minimum === null || s.value >= baseline.minimum) &&
                (baseline.maximum === null || s.value <= baseline.maximum) &&
                (baseline.direction === "lower"
                  ? s.value < baselineValue
                  : baseline.direction === "higher"
                    ? s.value > baselineValue
                    : s.value !== baselineValue),
            );
          updated = { ...updated, status: comparable === undefined ? "inconclusive" : "verified" };
        } else if (input.action === "spec") {
          const { task } = yield* acceptedChild(doc, finding, "advice");
          if (task.status !== "completed") return yield* new ChampionError({ reason: "conflict" });
          if (!input.specUrl) return yield* new ChampionError({ reason: "invalid" });
          updated = {
            ...updated,
            specUrl: input.specUrl,
            status: "open",
          };
        } else updated = { ...updated, status: "inconclusive" };
        yield* activity(doc.champion.id, `finding-${updated.status}`, input.evidence, updated);
        return yield* write({
          ...doc,
          findings: doc.findings.map((f) => (f.id === finding.id ? updated : f)),
        });
      }),
    );
  });
  const observedPhaseModel = Effect.fn("ChampionService.observedPhaseModel")(function* (
    doc: Document,
    finding: ChampionFinding,
    phase: string,
  ) {
    const proof = yield* acceptedChild(doc, finding, phase);
    if (proof.task.status !== "completed")
      return yield* new ChampionError({ reason: "unavailable" });
    const child = yield* threads
      .getThreadRecords(proof.shell.id, ["runs"])
      .pipe(Effect.mapError(failure));
    const completed = child.runs
      .filter((run) => run.status === "completed")
      .toSorted((a, b) => b.ordinal - a.ordinal);
    const model = completed[0]?.modelSelection.model;
    if (model === undefined) return yield* new ChampionError({ reason: "unavailable" });
    return model;
  });
  const verificationSelection = Effect.fn("ChampionService.verificationSelection")(function* (
    doc: Document,
    finding: ChampionFinding,
    request: AgentTaskRequest,
  ) {
    const reviewedModel = yield* observedPhaseModel(doc, finding, "review");
    if (Option.isNone(managedAgents)) return yield* new ChampionError({ reason: "unavailable" });
    const enabled = yield* Effect.filter(yield* providers.getProviders, (provider) =>
      threads.isProviderInstanceEnabledForProject({
        projectId: doc.champion.projectId,
        instanceId: provider.instanceId,
      }),
    );
    for (const provider of enabled)
      for (const model of provider.models) {
        if (model.slug === reviewedModel) continue;
        const result = yield* managedAgents.value
          .roles({
            projectId: doc.champion.projectId,
            providers: enabled,
            ceiling: "full-access",
            request,
            selection: { instanceId: provider.instanceId, model: model.slug },
          })
          .pipe(Effect.mapError(failure));
        const selected = result.roles.find((role) => role.role === request.role);
        if (selected?.selection != null && selected.refusal === null) return selected.selection;
      }
    return yield* new ChampionError({ reason: "unavailable" });
  });
  const admitInvestigation: ChampionService["Service"]["admitInvestigation"] = Effect.fn(
    "ChampionService.admitDelegation",
  )(function* (proof) {
    const doc = yield* byThread(proof.ownerThreadId);
    if (isCandidateWorkId(proof.binding.workId)) return;
    if (
      doc !== undefined &&
      ["verification", "review"].includes(phaseForRole(proof.binding.role) ?? "")
    ) {
      const finding = doc.findings.find(
        (f) => f.workId === proof.binding.workId && f.attemptId === proof.binding.attemptId,
      );
      if (!finding) return yield* new ChampionError({ reason: "unauthorized" });
      if (phaseForRole(proof.binding.role) === "verification") {
        if ((yield* observedPhaseModel(doc, finding, "review")) === proof.selection.model)
          return yield* new ChampionError({ reason: "unavailable" });
      } else {
        const verification = yield* acceptedChild(doc, finding, "verification").pipe(Effect.option);
        if (
          Option.isSome(verification) &&
          (yield* observedPhaseModel(doc, finding, "verification")) === proof.selection.model
        )
          return yield* new ChampionError({ reason: "unavailable" });
      }
    }
    yield* evidence.admit(proof);
    yield* PubSub.publish(changes, undefined);
  });
  /** Everyone a journey's confirmation must not be: the model that ran it and the one that drove it. */
  const journeyModels = (doc: Document) =>
    new Set([
      doc.champion.routineModelSelection.model,
      decisionEngines.jev.model,
      decisionEngines.luna.model,
    ]);
  const guardConfirmation = Effect.fn("ChampionService.guardConfirmation")(function* (
    ownerThreadId: ThreadId,
    request: AgentTaskRequest,
    task: string | undefined,
    followup: boolean,
  ) {
    const refuse = (detail: string) => new ChampionError({ reason: "unauthorized", detail });
    const doc = yield* byThread(ownerThreadId);
    if (doc === undefined || doc.champion.ownerThreadId !== ownerThreadId)
      return yield* refuse("Only the champion's owner thread starts a replay.");
    const candidate = yield* journeys
      .readCandidate(request.workId.slice(CANDIDATE_WORK_PREFIX.length))
      .pipe(Effect.mapError(failure));
    if (
      candidate === undefined ||
      candidate.championId !== doc.champion.id ||
      candidate.replay?.attemptId !== request.attemptId
    )
      return yield* refuse(
        "Start a replay with the workId and attemptId t3_champions_candidate_replay returned.",
      );
    if (followup)
      return yield* refuse("A replay judges alone, so it takes no follow-up. Start a new replay.");
    if (task?.trim() !== candidate.replay?.brief?.trim())
      return yield* refuse("A replay's task is its brief, unchanged.");
    if (
      request.role !== "browser" ||
      request.readOnly !== true ||
      request.demanding !== true ||
      (request.browser !== undefined && request.browser.backend !== "integrated")
    )
      return yield* refuse(
        "A replay runs as role browser with readOnly true, demanding true and the integrated browser.",
      );
    if (Option.isNone(managedAgents)) return yield* new ChampionError({ reason: "unavailable" });
    const enabled = yield* Effect.filter(yield* providers.getProviders, (provider) =>
      threads.isProviderInstanceEnabledForProject({
        projectId: doc.champion.projectId,
        instanceId: provider.instanceId,
      }),
    );
    const excluded = journeyModels(doc);
    const result = yield* managedAgents.value
      .roles({
        projectId: doc.champion.projectId,
        providers: enabled,
        ceiling: "full-access",
        request,
      })
      .pipe(Effect.mapError(failure));
    const selected = result.roles.find((role) => role.role === "browser");
    if (selected?.selection == null || selected.refusal !== null)
      return yield* new ChampionError({
        reason: "unavailable",
        detail: `No model can confirm this candidate: ${selected?.refusal ?? "the browser role has no choice"}.`,
      });
    if (excluded.has(selected.selection.model))
      return yield* new ChampionError({
        reason: "unavailable",
        detail: `A confirmation must differ from this check's own model and from Jev, and the browser role's demanding model is ${selected.selection.model}.`,
      });
    return selected.selection;
  });
  const journeysStart: ChampionService["Service"]["journeysStart"] = Effect.fn(
    "ChampionService.journeysStart",
  )(function* (caller) {
    const { check, doc } = yield* authenticate(caller);
    const config = doc.champion.journeys;
    if (config === undefined || check.kind !== "check")
      return yield* new ChampionError({
        reason: "conflict",
        detail: "This champion runs no journeys.",
      });
    const project = yield* projects.getById(doc.champion.projectId).pipe(Effect.mapError(failure));
    return yield* journeys.start({
      championId: doc.champion.id,
      threadId: check.threadId,
      checkId: check.id,
      config,
      openFindings: doc.findings
        .filter(
          (f) => f.id.includes(":qualitative:") && !["verified", "dismissed"].includes(f.status),
        )
        .map((f) => ({ id: f.id, title: f.title })),
      checkoutRoot: Option.isSome(project) ? project.value.workspaceRoot : null,
    });
  });
  const journeyCandidate: ChampionService["Service"]["journeyCandidate"] = Effect.fn(
    "ChampionService.journeyCandidate",
  )(function* (caller, input) {
    const { check, doc } = yield* authenticate(caller);
    const running = yield* journeys.readRecord(check.id).pipe(Effect.mapError(failure));
    if (doc.champion.journeys === undefined || running?.record.status !== "running")
      return yield* new ChampionError({
        reason: "conflict",
        detail: "No journey check is running.",
      });
    const journey = yield* journeys
      .markFailed(check.id, input.tabId)
      .pipe(Effect.mapError(failure));
    if (journey === undefined)
      return yield* new ChampionError({
        reason: "invalid",
        detail: `The server recorded no journey in tab ${input.tabId}.`,
      });
    const candidate: ChampionJourneys.JourneyCandidate = {
      id: yield* uuid,
      championId: doc.champion.id,
      checkId: check.id,
      kind: "candidate",
      status: "pending",
      reason: null,
      title: input.title,
      expected: input.expected,
      observed: input.observed,
      tabId: input.tabId,
      commit: running.record.commit,
      steps: journey.steps,
      finalUrl: journey.finalUrl,
      screenshots: journey.screenshots,
      findingId: null,
      replay: null,
    };
    yield* journeys.saveCandidate(candidate).pipe(Effect.mapError(failure));
    return { candidateId: candidate.id };
  });
  const candidateReplay: ChampionService["Service"]["candidateReplay"] = Effect.fn(
    "ChampionService.candidateReplay",
  )(function* (caller, input) {
    const { check, doc } = yield* authenticate(caller);
    const config = doc.champion.journeys;
    const running = yield* journeys.readRecord(check.id).pipe(Effect.mapError(failure));
    if (
      config === undefined ||
      running?.record.status !== "running" ||
      running.record.build === null
    )
      return yield* new ChampionError({
        reason: "conflict",
        detail: "No journey check is running.",
      });
    let candidate: ChampionJourneys.JourneyCandidate | undefined;
    if (input.findingId !== undefined) {
      const original = yield* journeys.confirmedFor(input.findingId).pipe(Effect.mapError(failure));
      if (original === undefined)
        return yield* new ChampionError({
          reason: "not-found",
          detail: "That finding has no recorded journey.",
        });
      candidate = {
        ...original,
        id: yield* uuid,
        checkId: check.id,
        kind: "retest",
        status: "pending",
        reason: null,
        replay: null,
      };
    } else if (input.candidateId !== undefined) {
      candidate = yield* journeys.readCandidate(input.candidateId).pipe(Effect.mapError(failure));
    }
    if (candidate === undefined || candidate.checkId !== check.id)
      return yield* new ChampionError({
        reason: "not-found",
        detail: "Name a candidate of this check, or a finding.",
      });
    if (candidate.status !== "pending" && candidate.status !== "inconclusive")
      return yield* new ChampionError({
        reason: "conflict",
        detail: `That candidate is already ${candidate.status}.`,
      });
    const workId = `${CANDIDATE_WORK_PREFIX}${candidate.id}`;
    const manifest = yield* journeys.provisionReplay({
      checkId: check.id,
      config,
      workId,
      build: running.record.build,
    });
    const shard = manifest.shards[0]!;
    const attemptId = `${candidate.id}:${manifest.id}`;
    const brief = replayBrief({
      title: candidate.title,
      expected: candidate.expected,
      observed: candidate.observed,
      origin: shard.origin,
      signInPath: shard.signInPath,
      steps: candidate.steps,
      finalUrl: candidate.finalUrl,
    });
    yield* journeys
      .saveCandidate({
        ...candidate,
        status: "pending",
        replay: { brief, targetId: manifest.id, workId, attemptId, commit: manifest.commit },
      })
      .pipe(Effect.mapError(failure));
    return { candidateId: candidate.id, workId, attemptId, brief };
  });
  const candidateSettle: ChampionService["Service"]["candidateSettle"] = Effect.fn(
    "ChampionService.candidateSettle",
  )(function* (caller, input) {
    const { check, doc } = yield* authenticate(caller);
    const config = doc.champion.journeys;
    const candidate = yield* journeys
      .readCandidate(input.candidateId)
      .pipe(Effect.mapError(failure));
    if (config === undefined || candidate === undefined || candidate.checkId !== check.id)
      return yield* new ChampionError({ reason: "not-found" });
    const { replay } = candidate;
    if (replay === null)
      return yield* new ChampionError({ reason: "conflict", detail: "Start its replay first." });
    if (candidate.status !== "pending")
      return {
        candidateId: candidate.id,
        status: candidate.status,
        reason: candidate.reason ?? "",
        findingId: candidate.findingId,
      };
    const records = yield* threads
      .getThreadRecords(doc.champion.ownerThreadId, ["subagents"])
      .pipe(Effect.mapError(failure));
    let found: { task: (typeof records.subagents)[number]; model: string } | undefined;
    for (const task of records.subagents) {
      if (task.childThreadId === null) continue;
      const shell = yield* threads
        .getThreadShell(task.childThreadId)
        .pipe(Effect.mapError(failure));
      if (
        shell?.agentTask?.workId === replay.workId &&
        shell.agentTask.attemptId === replay.attemptId
      )
        found = { task, model: shell.modelSelection.model };
    }
    const unsettled = (reason: string) => ({
      candidateId: candidate.id,
      status: "pending" as const,
      reason,
      findingId: null,
    });
    if (found === undefined) return unsettled("Its replay has not started: delegate it first.");
    if (!["completed", "failed", "cancelled", "interrupted"].includes(found.task.status))
      return unsettled("Its replay is still running.");
    const finished = found;
    const close = Effect.fn("ChampionService.closeCandidate")(function* (
      status: ChampionJourneys.JourneyCandidate["status"],
      reason: string,
      findingId: string | null,
    ) {
      yield* journeys
        .saveCandidate({
          ...candidate,
          status,
          reason,
          findingId: findingId ?? candidate.findingId,
        })
        .pipe(Effect.mapError(failure));
      yield* journeys.endReplay({
        checkId: check.id,
        config,
        workId: replay.workId,
        targetId: replay.targetId,
      });
      return {
        candidateId: candidate.id,
        status,
        reason,
        findingId: findingId ?? candidate.findingId,
      };
    });
    if (journeyModels(doc).has(finished.model))
      return yield* close(
        "inconclusive",
        `The replay ran on ${finished.model}, which may not judge this check's own work.`,
        null,
      );
    const verdict = parseVerdict(finished.task.result);
    if (verdict === null || verdict.verdict === "blocked")
      return yield* close(
        "inconclusive",
        verdict?.reason ?? "The replay ended without a verdict.",
        null,
      );
    if (candidate.kind === "retest") {
      if (verdict.verdict === "reproduced")
        return yield* close("still-failing", verdict.reason, candidate.findingId);
      if (replay.commit === candidate.commit)
        return yield* close(
          "inconclusive",
          "It passed, but on the same build it failed on, so this proves no fix.",
          candidate.findingId,
        );
      yield* mutate(
        Effect.gen(function* () {
          const current = yield* read(doc.champion.id);
          const finding = current.findings.find((f) => f.id === candidate.findingId);
          if (finding === undefined) return;
          const closed: ChampionFinding = {
            ...finding,
            status: "verified",
            revision: replay.commit,
            updatedAt: yield* now,
          };
          yield* write({
            ...current,
            findings: current.findings.map((f) => (f.id === finding.id ? closed : f)),
          });
          yield* activity(
            doc.champion.id,
            "finding-verified",
            `Its replay passed on build ${replay.commit}: ${verdict.reason}`,
            closed,
          );
        }),
      );
      return yield* close("fixed", verdict.reason, candidate.findingId);
    }
    if (verdict.verdict === "not-reproduced") return yield* close("rejected", verdict.reason, null);
    const findingId = yield* mutate(
      Effect.gen(function* () {
        // Two settles of one replay raise one finding.
        const latest = yield* journeys.readCandidate(candidate.id).pipe(Effect.mapError(failure));
        if (latest?.findingId != null) return latest.findingId;
        const current = yield* read(doc.champion.id);
        const clicks = yield* encodeClicks(
          candidate.steps.map((step) => ({
            url: step.url,
            target: step.target,
            option: step.option,
          })),
        ).pipe(Effect.mapError(failure));
        const evidenceText = [
          `${candidate.observed} Expected: ${candidate.expected}`,
          `Steps to reproduce, on a fresh copy of the seeded data (build ${replay.commit}):\n${describeSteps(candidate.steps)}`,
          `Recorded clicks: ${clicks}`,
          `Confirmed in isolation by ${finished.model}: ${verdict.reason}`,
          `Screenshot: ${verdict.screenshot ?? candidate.screenshots.at(-1) ?? "none recorded"}`,
        ].join("\n\n");
        // One finding per replayed bug, never merged by title: two bugs can read alike.
        const finding = yield* makeFinding(doc.champion.id, candidate.title, evidenceText);
        yield* write({ ...current, findings: [...current.findings, finding] });
        yield* journeys
          .saveCandidate({ ...candidate, findingId: finding.id })
          .pipe(Effect.mapError(failure));
        yield* activity(doc.champion.id, "finding-opened", finding.evidence, finding);
        return finding.id;
      }),
    );
    return yield* close("confirmed", verdict.reason, findingId);
  });
  const journeyRecord: ChampionService["Service"]["journeyRecord"] = (input) =>
    journeys.recordOf(input.checkId, input.includeJourneys === true);
  const guardDelegation: ChampionService["Service"]["guardDelegation"] = Effect.fn(
    "ChampionService.guardDelegation",
  )(function* ({
    ownerThreadId,
    request,
    clientRequestId,
    followup,
    task,
    childThreadId,
    forgeItem,
    remote,
  }) {
    if ((yield* byThread(ownerThreadId)) === undefined) return;
    if (isCandidateWorkId(request?.workId))
      return yield* guardConfirmation(ownerThreadId, request!, task, followup === true);
    if (yield* journeys.ownerBusy(ownerThreadId).pipe(Effect.mapError(failure)))
      return yield* new ChampionError({
        reason: "unauthorized",
        detail: "During a journey check the only delegation is a replay.",
      });
    if (yield* evidence.guard(ownerThreadId, request, clientRequestId, remote)) {
      const prior = yield* evidence.recordedBinding(ownerThreadId, clientRequestId);
      if (prior !== undefined) return prior.effective;
      if (followup) {
        if (!request || !childThreadId)
          return yield* new ChampionError({
            reason: "unauthorized",
            detail:
              "A follow-up to an investigation branch needs the branch's agentTask and the child thread it is continuing.",
          });
        return (yield* evidence.followupBinding(ownerThreadId, request, childThreadId)).effective;
      }
      const doc = yield* byThread(ownerThreadId);
      if (!doc || !request || Option.isNone(managedAgents))
        return yield* new ChampionError({ reason: "unavailable" });
      const enabled = yield* Effect.filter(yield* providers.getProviders, (provider) =>
        threads.isProviderInstanceEnabledForProject({
          projectId: doc.champion.projectId,
          instanceId: provider.instanceId,
        }),
      );
      const result = yield* managedAgents.value
        .roles({
          projectId: doc.champion.projectId,
          providers: enabled,
          ceiling: "full-access",
          request,
        })
        .pipe(Effect.mapError(failure));
      const selected = result.roles.find((entry) => entry.role === request.role);
      if (selected?.selection == null || selected.refusal !== null)
        return yield* new ChampionError({ reason: "unavailable" });
      return selected.selection;
    }
    return yield* mutate(
      Effect.gen(function* () {
        const doc = yield* byThread(ownerThreadId);
        if (doc === undefined) return;
        const refuse = (detail: string) => new ChampionError({ reason: "unauthorized", detail });
        if (doc.champion.ownerThreadId !== ownerThreadId)
          return yield* refuse(
            "Only the champion's owner thread delegates its repairs; a setup thread cannot.",
          );
        if (!request || !clientRequestId)
          return yield* refuse(
            "A champion delegation needs an agentTask with the finding's workId and attemptId, and a clientRequestId.",
          );
        if (doc.champion.lifecycle !== "active")
          return yield* refuse(
            "This champion is paused, so it cannot delegate. Report what you measured inline and raise the delegation you needed as attention.",
          );
        const finding = doc.findings.find(
          (f) => f.workId === request.workId && f.attemptId === request.attemptId,
        );
        if (!finding)
          return yield* refuse(
            "A champion delegates only for a finding or an investigation branch. For a repair, pass the finding's workId and attemptId from t3_champions_check_context. For read-only exploration, call t3_champions_start_investigation and delegate its returned branch.",
          );
        const phase = phaseForRole(request.role);
        if (!phase) return yield* refuse(`A champion cannot delegate to the ${request.role} role.`);
        if (["verified", "dismissed"].includes(finding.status))
          return yield* refuse(
            `This finding is ${finding.status}, so it takes no more work. Reopen it, or report a new finding.`,
          );
        if (request.projectId !== undefined && request.projectId !== doc.champion.projectId)
          return yield* refuse("A champion delegates only within its own project.");
        if (phase === "implementation" && request.workspaceAssignment !== "isolated")
          return yield* refuse(
            "Repairs must run in an isolated workspace. Delegate again with workspaceAssignment isolated.",
          );
        if (["advice", "review", "verification"].includes(phase) && request.readOnly !== true)
          return yield* refuse(
            `${request.role} work for a champion must be read-only. Delegate again with readOnly true.`,
          );
        const checks = yield* sql<{
          document_json: string;
        }>`SELECT document_json FROM champion_checks WHERE champion_id = ${doc.champion.id} AND thread_id = ${ownerThreadId} ORDER BY started_at DESC, rowid DESC LIMIT 1`.pipe(
          Effect.mapError(failure),
        );
        if (!checks[0])
          return yield* refuse(
            "This thread has no check in progress, so it cannot delegate. Start from a check.",
          );
        if (
          (yield* decodeCheck(checks[0].document_json).pipe(Effect.mapError(failure))).measureOnly
        )
          return yield* refuse(
            "This check is measure-only, so it cannot dispatch repairs. Report the finding; a later full check can act on it.",
          );
        if (phase === "lead") {
          if (!finding.specUrl)
            return yield* refuse(
              "A lead runs only for a finding with a Forge Spec. Record the Spec with t3_champions_update_finding action spec first.",
            );
          if (!followup && !forgeItem)
            return yield* refuse(
              "Start a lead with forgeItem set to the finding's Spec, so the lead works in that Spec's workspace.",
            );
          if (request.workspaceAssignment === "isolated")
            return yield* refuse(
              "A lead allocates its own Spec workspace. Delegate again without workspaceAssignment isolated.",
            );
          const advice = yield* acceptedChild(doc, finding, "advice").pipe(Effect.option);
          if (Option.isNone(advice) || advice.value.task.status !== "completed")
            return yield* refuse(
              "A lead starts only after an advisor on this finding attempt has completed. Delegate the advisor first and wait for it.",
            );
        }
        if (phase === "review" || phase === "verification") {
          const proof = yield* acceptedChild(doc, finding).pipe(Effect.option);
          if (Option.isNone(proof) || proof.value.task.status !== "completed")
            return yield* refuse(
              `${phase === "review" ? "Review" : "Verification"} starts only after this finding attempt's ${finding.specUrl === null ? "repair worker" : "lead"} has completed and handed back. Wait for it to finish.`,
            );
        }
        const distinctSelection =
          phase === "verification" && !followup
            ? yield* verificationSelection(doc, finding, request)
            : undefined;
        if (phase === "advice" && doc.champion.classes === undefined)
          yield* validateModel(doc.champion.setupModelSelection);
        const prior = yield* sql<{
          client_request_id: string;
          role: string;
          state: string;
        }>`SELECT client_request_id, role, state FROM champion_repair_claims WHERE work_id = ${finding.workId} AND attempt_id = ${finding.attemptId} AND phase = ${phase}`.pipe(
          Effect.mapError(failure),
        );
        if (
          prior[0] &&
          !followup &&
          (prior[0].client_request_id !== clientRequestId ||
            (prior[0].role !== request.role &&
              !(prior[0].role === "ui-verifier" && request.role === "browser")))
        )
          return yield* refuse(
            prior[0].client_request_id !== clientRequestId
              ? `This finding attempt's ${phase} was already requested as clientRequestId ${prior[0].client_request_id}. Repeat that exact request, or follow up on its task instead of starting another.`
              : `This finding attempt's ${phase} was already requested for the ${prior[0].role} role. Repeat it with that role, or follow up on its task.`,
          );
        if (followup) {
          const proof = yield* acceptedChild(doc, finding, phase).pipe(Effect.option);
          if (Option.isNone(proof))
            return yield* refuse(
              `There is no ${phase} task on this finding attempt to follow up. Start one instead.`,
            );
          if (childThreadId !== undefined && proof.value.shell.id !== childThreadId)
            return yield* refuse(
              `That child thread is not this finding attempt's current ${phase} task. Follow up the task it started.`,
            );
          if (phase === "lead") {
            const binding = proof.value.shell.workItem;
            if (forgeItem !== undefined)
              return yield* refuse(
                "A lead follow-up continues its own Spec; drop forgeItem from the follow-up.",
              );
            if (
              !binding ||
              forgeItemNumberFromUrl(finding.specUrl!, binding.origin) !== binding.number
            )
              return yield* refuse(
                "That lead is no longer bound to the finding's recorded Spec, so it cannot be followed up for this finding.",
              );
          }
          return (
            distinctSelection ??
            (phase === "advice" && doc.champion.classes === undefined
              ? doc.champion.setupModelSelection
              : undefined)
          );
        }
        const workIds = doc.findings.map((f) => f.workId);
        const active = yield* sql<{
          work_id: string;
          attempt_id: string;
        }>`SELECT DISTINCT work_id, attempt_id FROM champion_repair_claims WHERE work_id IN ${sql.in(workIds)} AND state IN ('reserved','unknown','accepted')`.pipe(
          Effect.mapError(failure),
        );
        const currentActive = active.filter((c) =>
          doc.findings.some((f) => f.workId === c.work_id && f.attemptId === c.attempt_id),
        );
        const alreadyActive = currentActive.some(
          (c) => c.work_id === finding.workId && c.attempt_id === finding.attemptId,
        );
        if (!alreadyActive && currentActive.length >= doc.champion.charter.maxConcurrentRepairs)
          return yield* refuse(
            `The charter allows ${doc.champion.charter.maxConcurrentRepairs} repair${doc.champion.charter.maxConcurrentRepairs === 1 ? "" : "s"} at once and that many are running. Wait for one to finish, or report this finding for a later check.`,
          );
        if (!prior[0] || prior[0].state === "rejected") {
          const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 1 }));
          const attempted = yield* sql<{
            work_id: string;
            attempt_id: string;
          }>`SELECT DISTINCT work_id, attempt_id FROM champion_repair_claims WHERE work_id IN ${sql.in(workIds)} AND updated_at >= ${since} AND state IN ('unknown','accepted','completed','failed')`.pipe(
            Effect.mapError(failure),
          );
          if (
            !attempted.some(
              (c) => c.work_id === finding.workId && c.attempt_id === finding.attemptId,
            ) &&
            attempted.length >= doc.champion.charter.maxRepairsPerDay
          )
            return yield* refuse(
              `The charter allows ${doc.champion.charter.maxRepairsPerDay} repair${doc.champion.charter.maxRepairsPerDay === 1 ? "" : "s"} a day and that many were started in the last 24 hours. Report this finding; a later check can repair it.`,
            );
        }
        if (!prior[0]) {
          yield* sql`INSERT INTO champion_repair_claims (work_id, attempt_id, phase, client_request_id, role, state, updated_at) VALUES (${finding.workId},${finding.attemptId},${phase},${clientRequestId},${request.role},'reserved',${yield* now})`.pipe(
            Effect.mapError(failure),
          );
          yield* activity(
            doc.champion.id,
            "repair-phase-reserved",
            `Managed ${request.role} ${phase} reserved before dispatch as clientRequestId ${clientRequestId}.`,
            finding,
          );
        } else if (prior[0].state === "rejected" || followup) {
          yield* sql`UPDATE champion_repair_claims SET state = 'reserved', role = ${request.role}, command_id = NULL, updated_at = ${yield* now} WHERE work_id = ${finding.workId} AND attempt_id = ${finding.attemptId} AND phase = ${phase}`.pipe(
            Effect.mapError(failure),
          );
        }
        const updated: ChampionFinding = {
          ...finding,
          repairAttention: null,
          ...((phase === "implementation" || phase === "lead") &&
          (followup || finding.status === "open" || finding.status === "inconclusive")
            ? { status: "working", revision: null, deliveredAt: null, delivery: null }
            : {}),
          updatedAt: yield* now,
        };
        yield* write({
          ...doc,
          findings: doc.findings.map((f) => (f.id === finding.id ? updated : f)),
        });
        return (
          distinctSelection ??
          (phase === "advice" && doc.champion.classes === undefined
            ? doc.champion.setupModelSelection
            : undefined)
        );
      }),
    );
  });
  const delegationOutcome: ChampionService["Service"]["delegationOutcome"] = Effect.fn(
    "ChampionService.delegationOutcome",
  )(function* (input) {
    if (!input.request || !input.clientRequestId) return;
    if (
      yield* evidence.outcome(
        input.ownerThreadId,
        input.request,
        input.clientRequestId,
        input.state,
      )
    ) {
      yield* PubSub.publish(changes, undefined);
      return;
    }
    const request = input.request;
    const phase = phaseForRole(request.role);
    if (!phase || (yield* byThread(input.ownerThreadId)) === undefined) return;
    yield* mutate(
      Effect.gen(function* () {
        const doc = yield* byThread(input.ownerThreadId);
        const finding = doc?.findings.find(
          (f) => f.workId === request.workId && f.attemptId === request.attemptId,
        );
        if (!doc || !finding) return;
        const claims = yield* sql<{
          command_id: string | null;
          state: string;
          client_request_id: string;
          latest_request_id: string | null;
        }>`SELECT command_id,state,client_request_id,latest_request_id FROM champion_repair_claims WHERE work_id = ${finding.workId} AND attempt_id = ${finding.attemptId} AND phase = ${phase}`.pipe(
          Effect.mapError(failure),
        );
        const claim = claims[0];
        if (
          !claim ||
          (claim.client_request_id !== input.clientRequestId && input.followup !== true)
        )
          return;
        if (input.followup === true) {
          yield* acceptedChild(doc, finding, phase);
          if (input.state === "failed" && claim.latest_request_id !== input.clientRequestId) return;
        }
        if (input.state === "started") {
          const active = yield* sql<{
            work_id: string;
            attempt_id: string;
          }>`SELECT DISTINCT work_id,attempt_id FROM champion_repair_claims WHERE work_id IN ${sql.in(doc.findings.map((f) => f.workId))} AND state IN ('reserved','unknown','accepted')`.pipe(
            Effect.mapError(failure),
          );
          const current = active.filter((c) =>
            doc.findings.some((f) => f.workId === c.work_id && f.attemptId === c.attempt_id),
          );
          if (
            !current.some(
              (c) => c.work_id === finding.workId && c.attempt_id === finding.attemptId,
            ) &&
            current.length >= doc.champion.charter.maxConcurrentRepairs
          )
            return yield* new ChampionError({ reason: "unauthorized" });
        }
        const commandId =
          input.commandId ??
          (claim.command_id === null ? undefined : CommandId.make(claim.command_id));
        let state =
          input.state === "started"
            ? "unknown"
            : input.state === "finished"
              ? "accepted"
              : commandId === undefined
                ? "rejected"
                : "unknown";
        if (input.state === "failed" && commandId !== undefined) {
          const receipt = yield* threads.getReceipt(commandId).pipe(Effect.option);
          if (Option.isSome(receipt) && Option.isSome(receipt.value))
            state = receipt.value.value.status;
        }
        yield* sql`UPDATE champion_repair_claims SET state = ${state}, command_id = ${commandId ?? null}, latest_request_id = ${input.clientRequestId}, latest_followup = ${input.followup === true ? 1 : 0}, updated_at = ${yield* now} WHERE work_id = ${finding.workId} AND attempt_id = ${finding.attemptId} AND phase = ${phase}`.pipe(
          Effect.mapError(failure),
        );
        const updated: ChampionFinding = {
          ...finding,
          ...(input.followup === true &&
          input.state === "started" &&
          (phase === "implementation" || phase === "lead")
            ? { status: "working", revision: null, deliveredAt: null, delivery: null }
            : {}),
          ...(state === "rejected" && finding.childThreadId === null ? { status: "open" } : {}),
          repairAttention:
            state === "rejected"
              ? `${phase} was refused before acceptance; retry clientRequestId ${input.clientRequestId} after correcting the refusal.`
              : state === "unknown" && input.state === "failed"
                ? `${phase} launch is uncertain; replay ${input.followup ? "follow-up" : "delegate_task"} clientRequestId ${input.clientRequestId}, never start a duplicate.`
                : null,
          updatedAt: yield* now,
        };
        yield* write({
          ...doc,
          findings: doc.findings.map((f) => (f.id === finding.id ? updated : f)),
        });
        yield* activity(
          doc.champion.id,
          `repair-${state}`,
          `${phase} ${input.followup ? "follow-up" : "dispatch"} ${state} for clientRequestId ${input.clientRequestId}; accepted child records remain authoritative.`,
          updated,
        );
      }),
    );
  });
  const history: ChampionService["Service"]["history"] = Effect.fn("ChampionService.history")(
    function* (input) {
      yield* read(input.id);
      const limit = input.limit ?? 50;
      const before = input.before ?? "9999";
      const rows = yield* sql<{ sort_key: string; kind: string; document_json: string }>`
      SELECT id AS sort_key, 'activity' AS kind, document_json FROM champion_activity
        WHERE champion_id = ${input.id} AND id < ${before}
      UNION ALL
      SELECT started_at || ':' || id AS sort_key, 'check' AS kind, document_json FROM champion_checks
        WHERE champion_id = ${input.id} AND started_at || ':' || id < ${before} AND status = 'reported'
      UNION ALL
      SELECT created_at || ':' || metric_id || ':' || version AS sort_key, 'definition' AS kind, document_json FROM champion_metric_definitions
        WHERE champion_id = ${input.id} AND created_at || ':' || metric_id || ':' || version < ${before}
      UNION ALL
      SELECT at || ':' || id AS sort_key, 'finding' AS kind, document_json FROM champion_finding_archive
        WHERE champion_id = ${input.id} AND at || ':' || id < ${before}
      ORDER BY sort_key DESC LIMIT ${limit + 1}
    `.pipe(Effect.mapError(failure));
      const page = rows.slice(0, limit);
      const activityItems = yield* Effect.forEach(
        page.filter((r) => r.kind === "activity"),
        (r) => decodeActivity(r.document_json).pipe(Effect.mapError(failure)),
      );
      const checks = yield* Effect.forEach(
        page.filter((r) => r.kind === "check"),
        (r) => decodeCheck(r.document_json).pipe(Effect.mapError(failure)),
      );
      const definitions = yield* Effect.forEach(
        page.filter((r) => r.kind === "definition"),
        (r) => decodeMetric(r.document_json).pipe(Effect.mapError(failure)),
      );
      const findings = yield* Effect.forEach(
        page.filter((r) => r.kind === "finding"),
        (r) => decodeFinding(r.document_json).pipe(Effect.mapError(failure)),
      );
      return {
        findings,
        definitions,
        activity: activityItems,
        samples: checks.flatMap((c) => c.samples ?? []),
        nextCursor: rows.length > limit ? (page.at(-1)?.sort_key ?? null) : null,
      };
    },
  );
  const reconcileRepairs = Effect.fn("ChampionService.reconcileRepairs")(function* (id: string) {
    const doc = yield* read(id);
    const timestamp = yield* now;
    const owner = yield* threads
      .getThreadShell(doc.champion.ownerThreadId)
      .pipe(Effect.mapError(failure));
    for (const finding of doc.findings.filter(
      (f) => !["verified", "dismissed"].includes(f.status),
    )) {
      const claims = yield* sql<{
        phase: string;
        state: string;
        updated_at: string;
        command_id: string | null;
        client_request_id: string;
        latest_request_id: string | null;
        latest_followup: number;
      }>`SELECT phase,state,updated_at,command_id,client_request_id,latest_request_id,latest_followup FROM champion_repair_claims WHERE work_id = ${finding.workId} AND attempt_id = ${finding.attemptId}`.pipe(
        Effect.mapError(failure),
      );
      let attention: string | null = null;
      let producer = finding.childThreadId;
      for (const claim of claims) {
        let state = claim.state;
        const proof = yield* acceptedChild(doc, finding, claim.phase).pipe(Effect.option);
        if (Option.isSome(proof)) {
          const { task } = proof.value;
          state =
            task.status === "completed"
              ? "completed"
              : ["failed", "cancelled", "interrupted"].includes(task.status)
                ? "failed"
                : "accepted";
          if (claim.phase === "implementation" || claim.phase === "lead")
            producer = task.childThreadId;
        } else if (claim.command_id !== null) {
          const receipt = yield* threads
            .getReceipt(CommandId.make(claim.command_id))
            .pipe(Effect.option);
          if (Option.isSome(receipt) && Option.isSome(receipt.value))
            state = receipt.value.value.status;
        } else if (
          claim.state === "reserved" &&
          owner?.activeRunId == null &&
          Date.parse(timestamp) - Date.parse(claim.updated_at) >= 60_000
        )
          state = "rejected";
        if (state === "failed" || state === "rejected")
          attention = `${claim.phase} ${state}; inspect activity and retry its stable identity or reopen a finished attempt.`;
        else if (
          Option.isNone(proof) &&
          Date.parse(timestamp) - Date.parse(claim.updated_at) >= 60_000
        )
          attention = `${claim.phase} ownership is unconfirmed; replay ${claim.latest_followup ? "follow-up" : "delegate_task"} clientRequestId ${claim.latest_request_id ?? claim.client_request_id}. An uncertain launch cannot authorize a duplicate child.`;
        if (state !== claim.state)
          yield* mutate(
            Effect.gen(function* () {
              yield* sql`UPDATE champion_repair_claims SET state = ${state}, updated_at = ${timestamp} WHERE work_id = ${finding.workId} AND attempt_id = ${finding.attemptId} AND phase = ${claim.phase}`.pipe(
                Effect.mapError(failure),
              );
              yield* activity(
                id,
                `repair-${state}`,
                `${claim.phase} reconciled from existing receipts and accepted child records.`,
                finding,
              );
            }),
          );
      }
      if (producer !== finding.childThreadId || attention !== (finding.repairAttention ?? null))
        yield* mutate(
          Effect.gen(function* () {
            const current = yield* read(id);
            const live = current.findings.find((f) => f.id === finding.id);
            if (!live || live.attemptId !== finding.attemptId) return;
            yield* write({
              ...current,
              findings: current.findings.map((f) =>
                f.id === finding.id
                  ? {
                      ...f,
                      childThreadId: producer,
                      repairAttention: attention,
                      updatedAt: timestamp,
                    }
                  : f,
              ),
              champion: {
                ...current.champion,
                attention: current.champion.attention.filter(
                  (a) => a !== "A repair child failed; inspect its activity before retrying.",
                ),
              },
            });
          }),
        );
    }
  });
  const runDue = Effect.gen(function* () {
    const timestamp = yield* now;
    const pendingDecisions = yield* sql<{
      id: string;
    }>`SELECT id FROM champion_decision_deliveries WHERE delivered = 0 LIMIT 100`.pipe(
      Effect.mapError(failure),
    );
    for (const row of pendingDecisions) yield* deliverDecision(row.id).pipe(Effect.ignore);
    for (const champion of (yield* list({})).champions) {
      const doc = { champion };
      const stale = champion.latestSamples?.filter((sample) => sample.health === "stale") ?? [];
      const needsAttention =
        champion.lifecycle === "active" && stale.some((sample) => sample.required);
      if (
        (needsAttention && !champion.attention.includes("Required measurements are stale.")) ||
        stale.some((sample) => sample.staleAt !== null && champion.updatedAt < sample.staleAt)
      )
        yield* mutate(
          Effect.gen(function* () {
            const current = yield* read(champion.id);
            yield* write({
              ...current,
              champion: {
                ...current.champion,
                attention: needsAttention
                  ? [
                      ...new Set([
                        ...current.champion.attention,
                        "Required measurements are stale.",
                      ]),
                    ]
                  : current.champion.attention,
              },
            });
          }),
        );
      if (champion.openFindingCount > 0) yield* reconcileRepairs(champion.id);
      const reconciled = yield* evidence.reconcile(champion.id);
      if (reconciled.changed) yield* PubSub.publish(changes, undefined);
      const existingAttention = champion.attention.filter((item) =>
        item.startsWith("Investigation:"),
      );
      if (existingAttention.join("\n") !== reconciled.attention.join("\n"))
        yield* mutate(
          Effect.gen(function* () {
            const current = yield* read(champion.id);
            yield* write({
              ...current,
              champion: {
                ...current.champion,
                attention: [
                  ...current.champion.attention.filter(
                    (item) => !item.startsWith("Investigation:"),
                  ),
                  ...reconciled.attention,
                ],
              },
            });
          }),
        );
      for (const pendingId of [
        doc.champion.outstandingCheckId,
        doc.champion.outstandingSetupId ?? null,
      ]) {
        if (pendingId === null) continue;
        const check = yield* readCheck(pendingId);
        if (check.reported || check.cancelled) continue;
        if (!check.dispatched) yield* dispatchCheck(check).pipe(Effect.ignore);
        const shell = check.dispatched
          ? yield* threads.getThreadShell(check.threadId).pipe(Effect.mapError(failure))
          : null;
        const records =
          shell !== null && check.dispatched
            ? yield* threads
                .getThreadRecords(check.threadId, ["runs"])
                .pipe(Effect.mapError(failure))
            : undefined;
        const runsById = new Map(records?.runs.map((run) => [run.id, run]));
        const matchingRuns =
          records?.runs.filter((run) =>
            checkRunMessages(run, runsById).includes(check.messageId),
          ) ?? [];
        const endedWithoutReport =
          matchingRuns.some((run) => ThreadManagement.isTerminalRunStatus(run.status)) &&
          !matchingRuns.some(ThreadManagement.isActiveRun);
        const endedAttention = `${check.kind === "setup" ? "Setup" : "Check"} run ended without an authenticated report.`;
        if (
          matchingRuns.some(ThreadManagement.isActiveRun) &&
          doc.champion.attention.some((item) => item.startsWith(endedAttention))
        ) {
          yield* mutate(
            Effect.gen(function* () {
              const current = yield* read(doc.champion.id);
              const latest = yield* readCheck(check.id);
              if (latest.reported || latest.cancelled || latest.messageId !== check.messageId)
                return;
              yield* write({
                ...current,
                champion: {
                  ...current.champion,
                  attention: current.champion.attention.filter(
                    (item) => !item.startsWith(endedAttention),
                  ),
                },
              });
            }),
          );
        }
        // Decided by the failure itself: an overloaded run can also leave the thread failed.
        const endedOnOverload =
          endedWithoutReport && isProviderOverloadedFailureCode(shell?.lastErrorCode);
        if (endedOnOverload && (check.automaticRetries ?? 0) < MAX_AUTOMATIC_CHECK_RETRIES) {
          yield* start(doc.champion.id, check.kind, false, true).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("champions.overload-retry-failed", {
                championId: doc.champion.id,
                checkId: check.id,
                cause,
              }).pipe(
                Effect.andThen(
                  mutate(
                    Effect.gen(function* () {
                      const current = yield* read(doc.champion.id);
                      const note = `${check.kind === "setup" ? "Setup" : "Check"} automatic retry after a provider overload could not start. ${check.kind === "setup" ? "Ask AI to try again" : "Check now"} to retry.`;
                      if (current.champion.attention.includes(note)) return;
                      yield* write({
                        ...current,
                        champion: {
                          ...current.champion,
                          attention: [...current.champion.attention, note],
                        },
                      });
                    }),
                  ).pipe(Effect.ignore),
                ),
              ),
            ),
          );
          continue;
        }
        const ownershipLost =
          check.dispatched &&
          (shell === null ||
            shell.deletedAt !== null ||
            shell.archivedAt !== null ||
            shell.status === "failed" ||
            shell.usageLimitResetAt != null);
        if (
          endedWithoutReport ||
          ownershipLost ||
          Date.parse(timestamp) - Date.parse(check.startedAt) > 60 * 60 * 1000
        ) {
          yield* mutate(
            Effect.gen(function* () {
              const current = yield* read(doc.champion.id);
              const latest = yield* readCheck(check.id);
              if (latest.reported || latest.cancelled || latest.messageId !== check.messageId)
                return;
              const attention = endedOnOverload
                ? `${check.kind === "setup" ? "Setup" : "Check"} automatic retries exhausted after ${MAX_AUTOMATIC_CHECK_RETRIES} provider overloads. ${check.kind === "setup" ? "Ask AI to try again" : "Check now"} to retry.`
                : endedWithoutReport
                  ? `${endedAttention} ${check.kind === "setup" ? "Ask AI to try again" : "Check now"} to retry.`
                  : `${check.kind === "setup" ? "Setup" : "Check"} report overdue or ownership lost. Inspect the ${check.kind === "setup" ? "setup" : "owner"} thread.`;
              if (!current.champion.attention.includes(attention))
                yield* write({
                  ...current,
                  champion: {
                    ...current.champion,
                    attention: [...current.champion.attention, attention],
                  },
                });
            }),
          );
        }
      }
      if (doc.champion.journeys !== undefined)
        for (const checkId of yield* journeys
          .orphanedChecks(doc.champion.id)
          .pipe(Effect.orElseSucceed(() => [] as string[])))
          yield* journeys
            .finish({
              checkId,
              championId: doc.champion.id,
              threadId: doc.champion.ownerThreadId,
              config: doc.champion.journeys,
              owner: undefined,
              forcedReason:
                "The server restarted during the check, so nothing watched it to its end.",
            })
            .pipe(Effect.ignore);
      if (
        doc.champion.outstandingCheckId === null &&
        doc.champion.lifecycle === "active" &&
        doc.champion.nextCheckAt !== null &&
        doc.champion.nextCheckAt <= timestamp
      )
        yield* start(doc.champion.id, "check", true).pipe(Effect.catch(() => Effect.void));
    }
  });
  const shellSubscription = yield* PubSub.subscribe(shellChanges);
  yield* Stream.fromSubscription(shellSubscription).pipe(
    Stream.runForEach(
      Effect.fn("ChampionService.refreshOwnerShell")(
        function* (threadId) {
          const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failure));
          if (shell === null || shell.deletedAt !== null) return;
          // Shell metadata reads the champion ledger; its attention edge needs a normal durable shell event.
          yield* threads
            .dispatch({
              type: "thread.metadata.update",
              threadId,
              commandId: CommandId.make(`champion-attention:${yield* uuid}`),
            })
            .pipe(Effect.mapError(failure));
        },
        Effect.catch(() => Effect.logWarning("Champion owner shell refresh unavailable.")),
      ),
    ),
    Effect.forkScoped,
  );
  yield* scheduler.register("champions", runDue);
  const authenticateOwner = Effect.fn("ChampionService.authenticateOwner")(function* (
    caller: Caller,
    id: string,
  ) {
    const { shell } = yield* authenticateLive(caller);
    const doc = yield* read(id);
    if (
      doc.champion.ownerThreadId !== shell.id ||
      doc.champion.projectId !== shell.projectId ||
      shell.agentTask !== undefined
    )
      return yield* new ChampionError({ reason: "unauthorized" });
  });
  const recordLearning: ChampionService["Service"]["recordLearning"] = Effect.fn(
    "ChampionService.recordLearning",
  )(function* (caller, input) {
    yield* authenticateOwner(caller, input.id);
    const value = yield* evidence.recordLearning(input);
    yield* PubSub.publish(changes, undefined);
    return value;
  });
  const contributeLearning: ChampionService["Service"]["contributeLearning"] = Effect.fn(
    "ChampionService.contributeLearning",
  )(function* (contributor, input) {
    const doc = yield* read(input.id);
    if (contributor.linkSessionId === null && contributor.threadId === doc.champion.ownerThreadId)
      return yield* new ChampionError({
        reason: "unauthorized",
        detail: "The Champion records its own learning with t3_champions_record_learning.",
      });
    if (doc.champion.lifecycle === "retired")
      return yield* new ChampionError({
        reason: "unauthorized",
        detail: "This Champion is retired and takes no new learnings.",
      });
    if (input.expectedCurrentId !== null) {
      // A contributor may revise a contribution; the Champion's own learning is its to supersede.
      const head = yield* learnings.read({ id: input.id, learningId: input.learningId }).pipe(
        Effect.catchIf(
          (error) => error.reason === "not-found",
          () => Effect.succeed(null),
        ),
      );
      if (
        head !== null &&
        head.current.revision.id === input.expectedCurrentId &&
        head.current.revision.contribution === undefined
      )
        return yield* new ChampionError({
          reason: "unauthorized",
          detail:
            "Only the Champion revises its own learning. Record what you found as a new learning with its own learningId.",
        });
    }
    const value = yield* evidence.recordLearning(input, contributor);
    yield* PubSub.publish(changes, undefined);
    return value;
  });
  const confirmLearning: ChampionService["Service"]["confirmLearning"] = Effect.fn(
    "ChampionService.confirmLearning",
  )(function* (caller, input) {
    yield* authenticateOwner(caller, input.id);
    const value = yield* learnings.confirm(input);
    yield* PubSub.publish(changes, undefined);
    return value;
  });
  const noteLearning: ChampionService["Service"]["noteLearning"] = Effect.fn(
    "ChampionService.noteLearning",
  )(function* (caller, input) {
    yield* authenticateOwner(caller, input.id);
    const value = yield* learnings.note(input);
    yield* PubSub.publish(changes, undefined);
    return value;
  });
  const synthesize: ChampionService["Service"]["synthesize"] = Effect.fn(
    "ChampionService.synthesize",
  )(function* (caller, input) {
    yield* authenticateOwner(caller, input.id);
    const value = yield* evidence.synthesis(input);
    yield* findingAction(
      {
        id: input.id,
        findingId: value.findingId,
        action: "decision",
        recommendationId: value.recommendationId,
        reason: value.summary.slice(0, 500),
      },
      { threadId: caller?.threadId, quote: undefined },
    );
    return value;
  });
  const startInvestigation: Evidence["startInvestigation"] = Effect.fn(
    "ChampionService.startInvestigation",
  )(function* (input) {
    const result = yield* evidence.startInvestigation(input);
    yield* PubSub.publish(changes, undefined);
    return result;
  });
  const cancelInvestigation: Evidence["cancelInvestigation"] = Effect.fn(
    "ChampionService.cancelInvestigation",
  )(function* (input) {
    const result = yield* evidence.cancelInvestigation(input);
    yield* PubSub.publish(changes, undefined);
    return result;
  });
  const startInvestigationFromOwner: ChampionService["Service"]["startInvestigationFromOwner"] =
    Effect.fn("ChampionService.startInvestigationFromOwner")(function* (caller, input) {
      yield* authenticateOwner(caller, input.id);
      return yield* startInvestigation(input);
    });
  const cancelInvestigationFromOwner: ChampionService["Service"]["cancelInvestigationFromOwner"] =
    Effect.fn("ChampionService.cancelInvestigationFromOwner")(function* (caller, input) {
      yield* authenticateOwner(caller, input.id);
      return yield* cancelInvestigation(input);
    });
  return ChampionService.of({
    classChoices,
    startInvestigationFromOwner,
    cancelInvestigationFromOwner,
    runtimeState: evidence.runtimeState,
    recommendation: evidence.recommendation,
    learningQuery: evidence.learningQuery,
    learningSearch: learnings.search,
    learningTopics: learnings.topics,
    learningRead: learnings.read,
    contributeLearning,
    confirmLearning,
    noteLearning,
    startInvestigation,
    cancelInvestigation,
    admitInvestigation,
    recordedInvestigationBinding: evidence.recordedBinding,
    recordLearning,
    synthesize,
    list,
    get,
    upsert,
    setLifecycle,
    propose,
    accept,
    discardProposal,
    completeSetup,
    cancelSetup,
    findingAction,
    setup: Effect.fn("ChampionService.setup")((input) => start(input.id, "setup")),
    runCheck: Effect.fn("ChampionService.runCheck")((input) => start(input.id, "check")),
    startMetricsLead,
    checkContext,
    proposeFromSetup,
    report,
    journeysStart,
    journeyCandidate,
    candidateReplay,
    candidateSettle,
    journeyRecord,
    updateDelivery,
    guardDelegation,
    delegationOutcome,
    history,
    runDue,
    subscribe: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(list(input)),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list(input))),
          );
        }),
      ),
  });
});

export const layer = Layer.effect(ChampionService, make).pipe(
  Layer.provide(ManagedTaskControl.layer),
  Layer.provide(ProcessRunner.layer),
);
