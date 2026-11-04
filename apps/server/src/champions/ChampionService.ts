import { forgeItemNumberFromUrl } from "@t3tools/shared/forgeLinks";
import * as SlipJayLandings from "../project/SlipJayLandings.ts";
import { invalidOptionSelections } from "../provider/modelSelectionValidation.ts";
import { isProviderUsageExhausted } from "@t3tools/shared/providerPools";
import {
  ChampionSummary,
  type ChampionLatestSample,
  ChampionDetail,
  ChampionMetric,
  ChampionProposal,
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
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
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

const sameFinding = Schema.toEquivalence(ChampionFinding);

const Document = Schema.Struct({
  champion: ChampionSummary,
  metrics: Schema.Array(ChampionMetric),
  proposal: Schema.NullOr(ChampionProposal),
  findings: Schema.Array(ChampionFinding),
});
type Document = typeof Document.Type;
const Check = Schema.Struct({
  id: Schema.String,
  championId: Schema.String,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
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
});
type Check = typeof Check.Type;
const isChampionError = Schema.is(ChampionError);
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
type DetailOperation<I> = (input: I) => Effect.Effect<ChampionDetail, ChampionError>;

export class ChampionService extends Context.Service<
  ChampionService,
  {
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
    readonly propose: DetailOperation<{
      id: string;
      metrics: ReadonlyArray<ChampionMetricInput>;
      reason: string;
    }>;
    readonly accept: DetailOperation<{ id: string }>;
    readonly discardProposal: DetailOperation<{ id: string }>;
    readonly cancelSetup: DetailOperation<{ id: string }>;
    readonly completeSetup: (
      caller: Caller,
      input: { summary: string },
    ) => Effect.Effect<ChampionDetail, ChampionError>;
    readonly findingAction: (
      input: typeof ChampionFindingActionInput.Type,
      actor?: "user" | "agent",
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
    readonly updateDelivery: (
      caller: Caller,
      input: typeof ChampionFindingDeliveryInput.Type,
    ) => Effect.Effect<ChampionDetail, ChampionError>;
    readonly guardDelegation: (input: {
      ownerThreadId: ThreadId;
      request: AgentTaskRequest | undefined;
      clientRequestId: string | undefined;
      followup?: boolean | undefined;
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
      "ticket-reviewer": "review",
      "spec-reviewer": "review",
      "ui-verifier": "verification",
      lead: "lead",
    } as Record<string, string>
  )[role];

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const projects = yield* ProjectService.ProjectService;
  const scheduler = yield* Scheduler.Scheduler;
  const landings = yield* Effect.serviceOption(SlipJayLandings.SlipJayLandings);
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<void>(1);
  const shellChanges = yield* PubSub.unbounded<ThreadId>();
  const failure = (cause: unknown) => new ChampionError({ reason: "unavailable", cause });
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const uuid = crypto.randomUUIDv4().pipe(Effect.mapError(failure));
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
    };
    yield* sql`INSERT INTO champion_activity (id, champion_id, document_json) VALUES (${entry.id}, ${id}, ${yield* encodeActivity(entry).pipe(Effect.mapError(failure))})`.pipe(
      Effect.mapError(failure),
    );
  });
  const byThread = Effect.fn("ChampionService.byThread")(function* (threadId: ThreadId) {
    const rows = yield* sql<{ document_json: string }>`SELECT document_json FROM champions
      WHERE json_extract(document_json, '$.champion.ownerThreadId') = ${threadId}
      OR json_extract(document_json, '$.champion.setupThreadId') = ${threadId}`.pipe(
      Effect.mapError(failure),
    );
    return rows[0] === undefined
      ? undefined
      : yield* decodeDocument(rows[0].document_json).pipe(Effect.mapError(failure));
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
  const upsert: ChampionService["Service"]["upsert"] = Effect.fn("ChampionService.upsert")(
    function* (input) {
      if (Option.isNone(yield* projects.getById(input.projectId).pipe(Effect.mapError(failure))))
        return yield* new ChampionError({ reason: "not-found" });
      yield* validateModel(input.setupModelSelection);
      yield* validateModel(input.routineModelSelection);
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
      VALUES (${check.id}, ${check.championId}, ${check.threadId}, ${check.messageId}, ${check.startedAt}, ${check.cancelled ? "cancelled" : check.reported ? "reported" : "pending"}, ${yield* encodeCheck(check).pipe(Effect.mapError(failure))})
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, message_id = excluded.message_id, document_json = excluded.document_json`.pipe(
      Effect.mapError(failure),
    );
  });
  const readCheck = Effect.fn("ChampionService.readCheck")(function* (id: string) {
    const rows = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_checks WHERE id = ${id}`.pipe(Effect.mapError(failure));
    if (!rows[0]) return yield* new ChampionError({ reason: "not-found" });
    return yield* decodeCheck(rows[0].document_json).pipe(Effect.mapError(failure));
  });
  const prompt = (doc: Document, check: Check) =>
    [
      `You own champion ${doc.champion.name} in this project. Purpose: ${doc.champion.purpose}`,
      check.kind === "setup"
        ? "SETUP: inspect the actual product and propose useful measurable metrics with t3_champions_propose_metrics, or call t3_champions_complete_setup with a no-change summary. Proposals require user acceptance. Do not edit the shared root or delegate repairs during setup."
        : "CHECK: call t3_champions_check_context, collect honest observations, and call t3_champions_report before finishing. Dispatch alone is not completion.",
      `Check claim: ${check.id}. Definitions were frozen when this check started. ${check.measureOnly ? "MEASURE ONLY: do not dispatch repairs." : "Own bounded improvements through normal delegate_task managed roles."}`,
      "Read and measure at the project root; every writer must use an isolated workspace. Never edit the shared root. Keep this owner thread and its namespace across checks. Do not archive or replace it while children are live.",
      "For metric breaches the server creates deterministic findings. Reconcile qualitative observations with known open findings: supply existingFindingId instead of paraphrasing a duplicate. Read history on demand, never fabricate a measurement.",
      "After reporting, call t3_champions_check_context to read finding workId/attemptId. Use these exact identities in delegate_task. Bounded repair: implementation-worker or chore-worker. Large/open work: advisor on the stronger selection, shape in Forge, then lead the Spec. Use existing role policy and SlipJay. If Forge/SlipJay is unavailable, report it explicitly as attention; never claim a repair was delivered without a revision.",
      "Use t3_champions_update_finding for handoff, confirmed SlipJay delivery and verification. Verification requires a comparable later measurement on the delivered/running revision. Missing evidence is inconclusive. Ordinary decisions go in the finding decision ledger and attention; keep measuring instead of blocking on questions.",
      `Delivery/review procedure: ${DEFAULT_CHAMPION_INSTRUCTIONS}. Charter: ${encodeCharter(doc.champion.charter)}. Known findings: ${encodeFindings(doc.findings.filter((f) => f.status !== "verified" && f.status !== "dismissed"))}`,
    ].join("\n\n");
  const dispatchCheck = Effect.fn("ChampionService.dispatchCheck")(function* (check: Check) {
    const doc = yield* read(check.championId);
    if ((yield* readCheck(check.id)).cancelled) return;
    const modelSelection =
      check.kind === "setup"
        ? doc.champion.setupModelSelection
        : doc.champion.routineModelSelection;
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
        provider?.requiresNewThreadForModelChange === true &&
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
  ) {
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
                if (
                  shell !== null &&
                  shell.activeRunId === null &&
                  shell.deletedAt === null &&
                  shell.archivedAt === null
                ) {
                  const retryId = yield* uuid;
                  const retry: Check = {
                    ...outstanding,
                    dispatchKind: "send",
                    dispatched: false,
                    launchStarted: false,
                    commandId: CommandId.make(`champion:${outstanding.id}:retry:${retryId}`),
                    messageId: MessageId.make(`champion:${outstanding.id}:retry:${retryId}`),
                    measureOnly: outstanding.measureOnly || doc.champion.lifecycle !== "active",
                  };
                  yield* saveCheck(retry);
                  yield* activity(
                    id,
                    "check-retry",
                    "The previous run ended without an authenticated report. A manual retry retains the check definitions and owner.",
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
            const check: Check = {
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
                      `${claim.kind === "setup" ? "Setup" : "Check"} dispatch unavailable. Retry uses the same durable claim; no fallback model was selected.`,
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
            proposal: { metrics: input.metrics, reason: input.reason },
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
    function* ({ id }) {
      return yield* mutate(
        sql
          .withTransaction(
            Effect.gen(function* () {
              const doc = yield* read(id);
              if (doc.proposal === null) return yield* new ChampionError({ reason: "conflict" });
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
              yield* activity(id, "metrics-accepted", doc.proposal.reason);
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
      providerThread?.providerSessionId !== caller.providerSessionId ||
      run.providerThreadId !== providerThread.id
    )
      return yield* new ChampionError({ reason: "unauthorized" });
    return { shell, run };
  });
  const authenticate = Effect.fn("ChampionService.authenticateCheck")(function* (caller: Caller) {
    const { shell, run } = yield* authenticateLive(caller);
    const rows = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_checks WHERE thread_id = ${shell.id} AND message_id = ${run.userMessageId}`.pipe(
      Effect.mapError(failure),
    );
    if (!rows[0]) return yield* new ChampionError({ reason: "unauthorized" });
    const check = yield* decodeCheck(rows[0].document_json).pipe(Effect.mapError(failure));
    if (check.cancelled) return yield* new ChampionError({ reason: "conflict" });
    const doc = yield* read(check.championId);
    if (doc.champion.projectId !== shell.projectId)
      return yield* new ChampionError({ reason: "unauthorized" });
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
    if (check.kind !== "setup") return yield* new ChampionError({ reason: "unauthorized" });
    const result = yield* propose({ id: check.championId, ...input });
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
                return yield* new ChampionError({ reason: "invalid" });
              const samples: ChampionSample[] = [];
              const findings = [...doc.findings];
              let findingsLimited = false;
              for (const sample of input.samples) {
                const metric = check.metrics.find((m) => m.id === sample.metricId);
                if (
                  metric === undefined ||
                  metric.version !== sample.version ||
                  metric.unit !== sample.unit ||
                  (sample.status === "measured" && metric.source !== sample.source) ||
                  (sample.status === "measured") !== (sample.value !== null) ||
                  (sample.value !== null && !Number.isFinite(sample.value)) ||
                  !Number.isFinite(Date.parse(sample.observedAt))
                )
                  return yield* new ChampionError({ reason: "invalid" });
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
                return yield* new ChampionError({ reason: "invalid" });
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
    yield* threads
      .sendToThread({
        projectId: doc.champion.projectId,
        threadId: doc.champion.ownerThreadId,
        commandId: CommandId.make(`champion-decision:${row.id}`),
        messageId: MessageId.make(`champion-decision:${row.id}`),
        text: `The user resolved decision ${row.id} for finding ${row.finding_id}. Apply this answer through the normal owner workflow without stopping routine measurements:\n${row.answer}`,
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
  const findingAction: ChampionService["Service"]["findingAction"] = Effect.fn(
    "ChampionService.findingAction",
  )(function* (input, actor = "user") {
    const result = yield* mutate(
      Effect.gen(function* () {
        const doc = yield* read(input.id);
        const finding = doc.findings.find((f) => f.id === input.findingId);
        if (finding === undefined) return yield* new ChampionError({ reason: "not-found" });
        if (["dismiss", "reopen"].includes(input.action)) {
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
          if (finding.decision?.status === "requested") return doc;
          updated = {
            ...updated,
            decision: {
              id: yield* uuid,
              question: input.reason,
              status: "requested",
              answer: null,
              requestedAt: at,
              resolvedAt: null,
            },
          };
        } else if (input.action === "resolve_decision") {
          if (actor !== "user") return yield* new ChampionError({ reason: "unauthorized" });
          if (!input.decisionId || finding.decision?.id !== input.decisionId)
            return yield* new ChampionError({ reason: "conflict" });
          if (finding.decision.status === "resolved") {
            if (finding.decision.answer !== input.reason)
              return yield* new ChampionError({ reason: "conflict" });
            return doc;
          }
          updated = {
            ...updated,
            decision: {
              ...finding.decision,
              status: "resolved",
              answer: input.reason,
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
        yield* activity(input.id, input.action, input.reason, updated);
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
  const guardDelegation: ChampionService["Service"]["guardDelegation"] = Effect.fn(
    "ChampionService.guardDelegation",
  )(function* ({ ownerThreadId, request, clientRequestId, followup, childThreadId, forgeItem }) {
    if ((yield* byThread(ownerThreadId)) === undefined) return;
    return yield* mutate(
      Effect.gen(function* () {
        const doc = yield* byThread(ownerThreadId);
        if (doc === undefined) return;
        const refuse = () => new ChampionError({ reason: "unauthorized" });
        if (
          doc.champion.ownerThreadId !== ownerThreadId ||
          doc.champion.lifecycle !== "active" ||
          !request ||
          !clientRequestId
        )
          return yield* refuse();
        const finding = doc.findings.find(
          (f) => f.workId === request.workId && f.attemptId === request.attemptId,
        );
        const phase = phaseForRole(request.role);
        if (
          !finding ||
          !phase ||
          ["verified", "dismissed"].includes(finding.status) ||
          (request.projectId !== undefined && request.projectId !== doc.champion.projectId) ||
          (phase === "implementation" && request.workspaceAssignment !== "isolated") ||
          (["advice", "review", "verification"].includes(phase) && request.readOnly !== true)
        )
          return yield* refuse();
        const checks = yield* sql<{
          document_json: string;
        }>`SELECT document_json FROM champion_checks WHERE champion_id = ${doc.champion.id} AND thread_id = ${ownerThreadId} ORDER BY started_at DESC, rowid DESC LIMIT 1`.pipe(
          Effect.mapError(failure),
        );
        if (
          !checks[0] ||
          (yield* decodeCheck(checks[0].document_json).pipe(Effect.mapError(failure))).measureOnly
        )
          return yield* refuse();
        if (phase === "lead") {
          if (
            (!followup && !forgeItem) ||
            !finding.specUrl ||
            request.workspaceAssignment === "isolated"
          )
            return yield* refuse();
          if ((yield* acceptedChild(doc, finding, "advice")).task.status !== "completed")
            return yield* refuse();
        }
        if (phase === "review" || phase === "verification") {
          const proof = yield* acceptedChild(doc, finding).pipe(Effect.option);
          if (Option.isNone(proof) || proof.value.task.status !== "completed")
            return yield* refuse();
        }
        if (phase === "advice") yield* validateModel(doc.champion.setupModelSelection);
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
          (prior[0].client_request_id !== clientRequestId || prior[0].role !== request.role)
        )
          return yield* refuse();
        if (followup) {
          const proof = yield* acceptedChild(doc, finding, phase);
          if (childThreadId !== undefined && proof.shell.id !== childThreadId)
            return yield* refuse();
          if (phase === "lead") {
            const binding = proof.shell.workItem;
            if (
              forgeItem !== undefined ||
              !binding ||
              forgeItemNumberFromUrl(finding.specUrl!, binding.origin) !== binding.number
            )
              return yield* refuse();
          }
          return phase === "advice" ? doc.champion.setupModelSelection : undefined;
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
          return yield* refuse();
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
            return yield* refuse();
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
          yield* sql`UPDATE champion_repair_claims SET state = 'reserved', command_id = NULL, updated_at = ${yield* now} WHERE work_id = ${finding.workId} AND attempt_id = ${finding.attemptId} AND phase = ${phase}`.pipe(
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
        return phase === "advice" ? doc.champion.setupModelSelection : undefined;
      }),
    );
  });
  const delegationOutcome: ChampionService["Service"]["delegationOutcome"] = Effect.fn(
    "ChampionService.delegationOutcome",
  )(function* (input) {
    if (!input.request || !input.clientRequestId) return;
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
      for (const pendingId of [
        doc.champion.outstandingCheckId,
        doc.champion.outstandingSetupId ?? null,
      ]) {
        if (pendingId === null) continue;
        const check = yield* readCheck(pendingId);
        if (!check.dispatched) yield* dispatchCheck(check).pipe(Effect.catch(() => Effect.void));
        const shell = check.dispatched
          ? yield* threads.getThreadShell(check.threadId).pipe(Effect.mapError(failure))
          : null;
        const ownershipLost =
          check.dispatched &&
          (shell === null ||
            shell.deletedAt !== null ||
            shell.archivedAt !== null ||
            shell.status === "failed" ||
            shell.usageLimitResetAt != null);
        if (ownershipLost || Date.parse(timestamp) - Date.parse(check.startedAt) > 60 * 60 * 1000) {
          yield* mutate(
            Effect.gen(function* () {
              const current = yield* read(doc.champion.id);
              const attention = `${check.kind === "setup" ? "Setup" : "Check"} report overdue or ownership lost. Inspect the ${check.kind === "setup" ? "setup" : "owner"} thread.`;
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
  return ChampionService.of({
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
    checkContext,
    proposeFromSetup,
    report,
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

export const layer = Layer.effect(ChampionService, make);
