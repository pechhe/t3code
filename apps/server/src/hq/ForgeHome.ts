/**
 * Forge Home and person-note delivery use the person's delegated HQ connection. The delegation
 * stays on the server. An outbox survives restarts; deterministic command, message and thread
 * ids let retries recover a send or launch whose delivery report did not reach HQ.
 */
import {
  ForgeHomeError,
  type ForgeHome as ForgeHomeView,
  type ForgeHomeDecideInput,
  type ForgeHomeDecideResult,
  type ForgeHomeAnswerInput,
  type ForgeHomeItem,
  type ForgeHomeNeed,
  type ForgeHomeState,
  CommandId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { forgeItemUrl } from "@t3tools/shared/forgeLinks";
import { sameHqAddress } from "@t3tools/shared/hqOrigins";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as Project from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import {
  BUILD_MAX_REREAD_INTERVAL_MS,
  BUILD_REREAD_INTERVAL_MS,
  fingerprintOf,
  nextInterval,
  type Cadence,
} from "./ForgeWorkItems.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";

/** Where #4070 kept a separate decision token; removed at startup now the HQ connection decides. */
const RETIRED_STORE_NAME = "hq-build-decisions";
/** A delivery that fails is tried again after this, doubling to the Forge re-read cap. */
const DELIVERY_RETRY_MS = 5_000;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** HQ's own `Item` fields Forge Home names a Spec by. The rest of its view is left out. */
const HqItem = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  ref: Schema.optionalKey(Schema.NullOr(Schema.String)),
  title: Schema.String,
  status: Schema.String,
});
const HqCard = Schema.Struct({
  bodyRevision: Schema.Int,
  published: Schema.Array(Schema.Struct({ repository: Schema.String, revision: Schema.String })),
  reviewRunId: Schema.String,
});
const HqAcceptance = Schema.Struct({
  kind: Schema.Literal("acceptance"),
  spec: Schema.Struct({
    ...HqItem.fields,
    readiness: Schema.Struct({
      rows: Schema.Array(
        Schema.Struct({
          rowId: Schema.String,
          text: Schema.String,
          verdict: Schema.Literals(["met", "not_met", "missing", "stale"]),
          evidence: Schema.NullOr(Schema.String),
        }),
      ),
      // An HQ from before #4070's review fixes sends no checks; its card shows none.
      checks: Schema.optional(
        Schema.Array(Schema.Struct({ label: Schema.String, met: Schema.NullOr(Schema.Boolean) })),
      ),
    }),
    reviewSummary: Schema.optional(Schema.NullOr(Schema.String)),
    tryIt: Schema.optional(Schema.NullOr(Schema.String)),
    card: Schema.optional(Schema.NullOr(HqCard)),
    resolvedFindings: Schema.optional(
      Schema.Array(
        Schema.Struct({
          // HQ's review finding says what it was in `summary`.
          finding: Schema.Struct({ summary: Schema.String }),
        }),
      ),
    ),
  }),
  // The Proposed Decisions this Spec proposed (YardSmith YS-277), which HQ nests in its card rather
  // than listing on their own; an HQ from before sends none.
  decisions: Schema.optional(Schema.Array(HqItem)),
});
const HqHoldNeed = Schema.Struct({
  kind: Schema.Literal("hold"),
  item: HqItem,
  hold: Schema.Struct({
    id: Schema.optional(Schema.String),
    kind: Schema.String,
    note: Schema.String,
    openedAt: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
const HqDecisionNeed = Schema.Struct({ kind: Schema.Literal("decision"), decision: HqItem });
const HqArcNeed = Schema.Struct({
  kind: Schema.Literals(["arc_review", "arc_check_in"]),
  arc: HqItem,
  since: Schema.optional(Schema.NullOr(Schema.String)),
});
const HqHome = Schema.Struct({
  needsYou: Schema.Array(Schema.Unknown),
});
const decodeHome = Schema.decodeUnknownOption(HqHome);
const decodeAcceptance = Schema.decodeUnknownOption(HqAcceptance);
const decodeArcNeed = Schema.decodeUnknownOption(HqArcNeed);
const decodeHoldNeed = Schema.decodeUnknownOption(HqHoldNeed);
const decodeDecisionNeed = Schema.decodeUnknownOption(HqDecisionNeed);

const HqDecided = Schema.Struct({
  finding: Schema.NullOr(Schema.Struct({ id: Schema.String, note: Schema.String })),
  leadThread: Schema.NullOr(Schema.Struct({ harness: Schema.String, sessionRef: Schema.String })),
  spec: HqItem,
});
const decodeDecided = Schema.decodeUnknownOption(HqDecided);
const HqOutcome = Schema.Struct({
  status: Schema.String,
  code: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Unknown),
});
const decodeOutcome = Schema.decodeUnknownOption(HqOutcome);

const itemOf = (item: typeof HqItem.Type): ForgeHomeItem => ({
  id: item.id,
  number: item.number,
  ref: item.ref ? item.ref : null,
  title: item.title,
  status: item.status,
});

const refusalMessages: Record<string, string> = {
  send_back_note_required: "Add a note to send this back.",
  acceptance_card_stale: "This Spec changed after the card was shown.",
  hold_unavailable: "This hold is no longer available.",
  hold_not_person: "This hold does not need a person to answer it.",
  answer_required: "Add an answer to this hold.",
  hq_access_denied: "Weave no longer lets this account use Forge.",
};

const hqErrorMessage = (code: string | undefined) =>
  (code === undefined ? undefined : refusalMessages[code]) ??
  (code === undefined ? "Weave refused that." : `Weave refused that (${code}).`);

export class ForgeHome extends Context.Service<
  ForgeHome,
  {
    /** Forge Home as the button shows it; HQ is asked at most as often as Forge items are. */
    readonly read: Effect.Effect<ForgeHomeState>;
    /** Resolves once any refresh of Home from HQ begun by a read has finished. */
    readonly refreshed: Effect.Effect<void>;
    /** Accept or Send back as the person; a Send back's note is then delivered to the lead. */
    readonly decide: (
      input: ForgeHomeDecideInput,
    ) => Effect.Effect<ForgeHomeDecideResult, ForgeHomeError>;
    readonly answer: (
      input: ForgeHomeAnswerInput,
    ) => Effect.Effect<ForgeHomeDecideResult, ForgeHomeError>;
    /** Claims, delivers and reports pending person notes; the retry loop runs this. */
    readonly settleDeliveries: Effect.Effect<{ readonly failed: number }>;
  }
>()("t3/hq/ForgeHome") {}

/**
 * Home is one projection of every Spec, so no single agent's write expires it: only its own
 * cadence does, and a person's own decision or answer forgets it.
 */
interface CachedHome extends Cadence {
  readonly key: string;
  readonly state: ForgeHomeState;
  readonly attemptedAt: number;
}

interface DeliveryRow {
  readonly findingId: string;
  readonly specLabel: string;
  readonly note: string;
  readonly leadHarness: string | null;
  readonly leadSessionRef: string | null;
  readonly state: "pending" | "delivered" | "undeliverable";
  readonly detail: string | null;
  readonly reportedAt: string | null;
  /** The HQ that recorded the finding; only it is told how delivery went. */
  readonly hqOrigin: string;
  readonly noteKind: "send_back" | "answer" | "decision";
  /** The Proposed Decision a `decision` note was sent back on (YS-277), as `#N “title”`. */
  readonly decisionLabel: string | null;
  readonly specProject: string | null;
  readonly specNumber: number | null;
  readonly claimed: number;
  readonly deliveredThreadId: string | null;
}

const HqNote = Schema.Struct({
  id: Schema.String,
  note: Schema.String,
  kind: Schema.Literals(["send_back", "answer", "decision"]),
  decision: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        number: Schema.Int,
        ref: Schema.optional(Schema.NullOr(Schema.String)),
        title: Schema.String,
      }),
    ),
  ),
  spec: Schema.Struct({
    id: Schema.String,
    number: Schema.Int,
    ref: Schema.optional(Schema.NullOr(Schema.String)),
    title: Schema.String,
    project: Schema.NullOr(Schema.String),
  }),
  leadThread: Schema.NullOr(Schema.Struct({ harness: Schema.String, sessionRef: Schema.String })),
  claim: Schema.NullOr(Schema.Struct({ environmentId: Schema.String })),
});
const decodeNotes = Schema.decodeUnknownOption(
  Schema.Union([Schema.Array(HqNote), Schema.Struct({ notes: Schema.Array(HqNote) })]),
);

/**
 * The T3 thread a Forge lead session names (Spec #4070): harness `t3code` or `t3`, with a bare thread
 * id (how T3 leads report themselves) or `<environment>/<thread>` (how T3 reports a delivered note).
 * Null for any other harness or form; `environmentId` is null for a bare thread id, meaning this
 * environment.
 */
export const leadThreadOf = (lead: { readonly harness: string; readonly sessionRef: string }) => {
  if (lead.harness !== "t3code" && lead.harness !== "t3") return null;
  const parts = lead.sessionRef.split("/");
  if (parts.some((part) => part === "") || parts.length > 2) return null;
  return parts.length === 2
    ? { environmentId: parts[0]!, threadId: parts[1]! }
    : { environmentId: null, threadId: parts[0]! };
};

const sendBackMessageText = (input: { readonly specLabel: string; readonly note: string }) =>
  [
    `Your owner sent ${input.specLabel} back from Forge.`,
    "",
    `Their note: ${input.note}`,
    "",
    `This is a blocking finding on ${input.specLabel}: fix what it says and land the change, then it can be judged again.`,
  ].join("\n");

const notConnected = new ForgeHomeError({
  reason: "not_connected",
  message:
    "T3 is not connected to Weave. Connect it in Settings → Integrations → Weave → Connect to Weave.",
});

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const hq = yield* HqAgentConnections.HqAgentConnections;
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* Project.ProjectService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const launchContext = yield* Effect.context<FileSystem.FileSystem | ServerConfig.ServerConfig>();
  const lock = yield* KeyedLock.make<string>();
  const scope = yield* Effect.scope;
  let refreshing: Fiber.Fiber<unknown> | undefined;
  let cached: CachedHome | undefined;

  /** One call to HQ's decisions endpoint as the person. A transport failure carries nothing. */
  const post = (body: Record<string, unknown>, origin?: string) =>
    hq.decide({ body, ...(origin === undefined ? {} : { origin }) }).pipe(
      Effect.map((response) => ({
        ...response,
        outcome: decodeJson(response.text).pipe(Option.flatMap(decodeOutcome)),
      })),
    );

  const stateOf = (
    origin: string | null,
    status: ForgeHomeState["status"],
    home: ForgeHomeView | null,
    readAt: string | null,
  ): ForgeHomeState => ({
    status,
    origin,
    buildUrl: origin === null ? null : `${origin}/build`,
    home,
    readAt,
  });

  // An older HQ is asked again after a while, so updating HQ needs no T3 restart.
  let capabilities: { key: string; answer: boolean; notes: boolean; at: number } | undefined;
  const probe = Effect.fn("ForgeHome.probe")(
    function* () {
      const connection = yield* hq.read;
      if (connection === null) return { answer: false, notes: false };
      const now = yield* Clock.currentTimeMillis;
      if (
        capabilities?.key === connection.connection &&
        (capabilities.notes || now - capabilities.at < Duration.toMillis(Duration.minutes(5)))
      )
        return capabilities;
      const response = yield* post({ action: "notes", undelivered: true }, connection.origin);
      const raw = decodeJson(response.text);
      const invalid =
        response.status === 400 &&
        Option.exists(
          raw,
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "error" in value &&
            value.error === "action_invalid",
        );
      if (
        invalid ||
        (response.status === 200 &&
          Option.exists(response.outcome, (o) => o.status === "succeeded"))
      ) {
        capabilities = { key: response.connection, answer: !invalid, notes: !invalid, at: now };
      }
      return capabilities?.key === connection.connection
        ? capabilities
        : { answer: false, notes: false };
    },
    (effect) => lock.withLock("capabilities", effect),
  );

  const viewOf = (
    home: typeof HqHome.Type,
    origin: string,
    supported: { answer: boolean; notes: boolean },
  ): ForgeHomeView => {
    // A Proposed Decision HQ nests in its Specs' cards is listed once, after the first of them.
    const listed = new Set<string>();
    const decisionNeed = (item: typeof HqItem.Type): ReadonlyArray<ForgeHomeNeed> => {
      if (listed.has(item.id)) return [];
      listed.add(item.id);
      return [
        {
          kind: "decision",
          spec: itemOf(item),
          url: forgeItemUrl(origin, item.number),
          detail: null,
        },
      ];
    };
    const needsYou = home.needsYou.flatMap((raw): ReadonlyArray<ForgeHomeNeed> => {
      const acceptance = decodeAcceptance(raw);
      if (Option.isSome(acceptance)) {
        const spec = acceptance.value.spec;
        const card = spec.card ?? null;
        return [
          {
            kind: "acceptance",
            spec: itemOf(spec),
            url: forgeItemUrl(origin, spec.number),
            repositories: [...new Set((card?.published ?? []).map((source) => source.repository))],
            checks: spec.readiness.checks ?? [],
            reviewSummary: spec.reviewSummary ?? null,
            tryIt: spec.tryIt ?? null,
            rows: spec.readiness.rows,
            card,
            resolvedFindings: (spec.resolvedFindings ?? []).map(({ finding }) => ({
              title: finding.summary,
            })),
          },
          ...(acceptance.value.decisions ?? []).flatMap(decisionNeed),
        ];
      }
      const hold = decodeHoldNeed(raw);
      if (Option.isSome(hold))
        return [
          {
            kind: "hold",
            spec: itemOf(hold.value.item),
            url: forgeItemUrl(origin, hold.value.item.number),
            holdId: hold.value.hold.id ?? null,
            holdKind: hold.value.hold.kind,
            question: hold.value.hold.note,
            since: hold.value.hold.openedAt ?? null,
          },
        ];
      const decision = decodeDecisionNeed(raw);
      if (Option.isSome(decision)) return decisionNeed(decision.value.decision);
      const arc = decodeArcNeed(raw);
      if (Option.isSome(arc))
        return [
          {
            kind: arc.value.kind,
            spec: itemOf(arc.value.arc),
            // Each action adds its own `?act=`.
            url: forgeItemUrl(origin, arc.value.arc.number),
            detail:
              arc.value.kind === "arc_review"
                ? "Review date reached: continue or close"
                : `No check-in since ${arc.value.since ?? "unknown"}`,
          },
        ];
      return [];
    });
    return {
      needsYou,
      count: needsYou.length,
      capabilities: { answer: supported.answer, notes: supported.notes },
    };
  };

  const isoNow = Clock.currentTimeMillis.pipe(
    Effect.map((now) => DateTime.formatIso(DateTime.makeUnsafe(now))),
  );

  const isFresh = (previous: CachedHome, now: number) =>
    now - previous.attemptedAt < previous.intervalMs;

  /** Asks HQ for Home unless the last answer is still within its cadence. */
  const refreshHome = lock.withLock(
    "home",
    Effect.gen(function* () {
      const connected = yield* hq.read.pipe(Effect.orElseSucceed(() => null));
      if (connected === null) {
        cached = undefined;
        return stateOf(null, "not_connected", null, null);
      }
      const now = yield* Clock.currentTimeMillis;
      const previous = cached?.key === connected.connection ? cached : undefined;
      if (previous !== undefined && isFresh(previous, now)) return previous.state;
      const answered = yield* post({ action: "home" }).pipe(Effect.result);
      if (answered._tag === "Failure" && answered.failure.reason === "not_connected") {
        cached = undefined;
        return stateOf(null, "not_connected", null, null);
      }
      const response = answered._tag === "Success" ? Option.some(answered.success) : Option.none();
      // The connection that answered, which a reconnect since `read` may have changed.
      const key = Option.isSome(response) ? response.value.connection : connected.connection;
      const origin = Option.isSome(response) ? response.value.origin : connected.origin;
      const fresh = key === connected.connection ? previous : undefined;
      const value =
        Option.isSome(response) && response.value.status === 200
          ? response.value.outcome.pipe(
              Option.filter((outcome) => outcome.status === "succeeded"),
              Option.flatMap((outcome) => decodeHome(outcome.value)),
            )
          : Option.none();
      if (Option.isSome(value)) {
        const supported = yield* probe().pipe(
          Effect.orElseSucceed(() => ({ answer: false, notes: false })),
        );
        const view = viewOf(value.value, origin, supported);
        // HQ counts every need; one T3 cannot read would otherwise vanish from the cards silently.
        const dropped = value.value.needsYou.length - view.needsYou.length;
        if (dropped > 0)
          yield* Effect.logWarning("Forge Home has needs T3 could not read", {
            dropped,
            kinds: value.value.needsYou.map((need) =>
              typeof need === "object" && need !== null && "kind" in need ? String(need.kind) : "?",
            ),
          });
        const fingerprint = fingerprintOf(view);
        cached = {
          key,
          attemptedAt: now,
          fingerprint,
          intervalMs: nextInterval(fresh, fingerprint),
          state: stateOf(origin, "ready", view, DateTime.formatIso(DateTime.makeUnsafe(now))),
        };
        return cached.state;
      }
      const refused = Option.isSome(response) && response.value.status === 401;
      if (!refused)
        yield* Effect.logWarning("Could not read Forge Home from HQ", {
          status: Option.isSome(response) ? response.value.status : "unreachable",
        });
      const state = refused
        ? stateOf(origin, "invalid_token", null, null)
        : stateOf(origin, "unavailable", fresh?.state.home ?? null, fresh?.state.readAt ?? null);
      cached = {
        key,
        attemptedAt: now,
        fingerprint: undefined,
        // A struggling HQ is not asked every minute: consecutive failures double the wait.
        intervalMs:
          fresh?.state.status === "unavailable"
            ? Math.min(fresh.intervalMs * 2, BUILD_MAX_REREAD_INTERVAL_MS)
            : BUILD_REREAD_INTERVAL_MS,
        state,
      };
      return state;
    }),
  );

  /**
   * Home as last known, refreshed from HQ in the background once its cadence lapses, so a slow
   * HQ never holds a client up. The refresh outlives the client's request: a client that gives
   * up still leaves its answer behind. Only a read with nothing known waits for HQ.
   */
  const readHome = Effect.gen(function* () {
    const connected = yield* hq.read.pipe(Effect.orElseSucceed(() => null));
    const previous =
      connected !== null && cached?.key === connected.connection ? cached : undefined;
    const refresh = Effect.forkIn(refreshHome, scope);
    if (previous === undefined) return yield* Fiber.join(yield* refresh);
    const now = yield* Clock.currentTimeMillis;
    if (!isFresh(previous, now)) refreshing = yield* refresh;
    return previous.state;
  });
  const refreshed = Effect.suspend(() =>
    refreshing === undefined ? Effect.void : Fiber.await(refreshing).pipe(Effect.asVoid),
  );

  /** A decision changes what Home says, so the next read asks HQ. */
  const forget = Effect.sync(() => {
    cached = undefined;
  });

  const unreportedDeliveries = sql<DeliveryRow>`
      SELECT finding_id AS "findingId", spec_label AS "specLabel", note,
        lead_harness AS "leadHarness", lead_session_ref AS "leadSessionRef", state, detail,
        reported_at AS "reportedAt", hq_origin AS "hqOrigin", note_kind AS "noteKind",
        decision_label AS "decisionLabel",
        spec_project AS "specProject", spec_number AS "specNumber", claimed,
        delivered_thread_id AS "deliveredThreadId"
      FROM build_send_back_deliveries
      WHERE reported_at IS NULL
      ORDER BY created_at
    `;

  /** The thread a lead's session names, or why there is none this environment can write to. */
  const deliver = Effect.fn("ForgeHome.deliver")(function* (row: DeliveryRow) {
    const undeliverable = (detail: string) =>
      Effect.succeed({ state: "undeliverable" as const, detail });
    if (row.claimed === 0 && (row.leadHarness === null || row.leadSessionRef === null))
      return yield* undeliverable("Forge had no lead session for this Spec.");
    const lead =
      row.leadHarness === null || row.leadSessionRef === null
        ? null
        : leadThreadOf({ harness: row.leadHarness, sessionRef: row.leadSessionRef });
    if (row.claimed === 0 && lead === null)
      return yield* undeliverable("The lead is not a T3 thread.");
    if (lead !== null && lead.environmentId !== null && lead.environmentId !== environmentId)
      return yield* undeliverable("The lead thread is in another T3 environment.");
    const fallbackId = `build-note:${row.findingId}`;
    const target = row.deliveredThreadId ?? lead?.threadId;
    const shell =
      target === undefined ? null : yield* threads.getThreadShell(ThreadId.make(target));
    if (row.claimed === 0 && (shell === null || shell.deletedAt !== null))
      return yield* undeliverable("The lead thread no longer exists.");
    if (row.claimed === 0 && shell?.archivedAt !== null)
      return yield* undeliverable("The lead thread is archived.");
    const text =
      row.claimed === 0
        ? sendBackMessageText(row)
        : row.noteKind === "answer"
          ? `Your owner answered your hold on ${row.specLabel}: ${row.note}`
          : row.noteKind === "decision"
            ? `Your owner sent back ${row.decisionLabel ? `Decision ${row.decisionLabel}, which` : "a Decision that"} ${row.specLabel} proposed, to revise or drop: ${row.note}`
            : `Your owner sent ${row.specLabel} back: ${row.note}`;
    if (
      row.claimed !== 0 &&
      (target === fallbackId ||
        shell === null ||
        shell.deletedAt !== null ||
        shell.archivedAt !== null)
    ) {
      const snapshot = yield* projects.snapshot;
      const project = snapshot.projects.find(
        (p) =>
          p.deletedAt === null &&
          row.specProject !== null &&
          p.repositoryIdentity?.canonicalKey.split("/").slice(1).join("/").toLowerCase() ===
            row.specProject.toLowerCase(),
      );
      if (project === undefined)
        return yield* undeliverable(
          `No registered T3 project matches ${row.specProject ?? "this Spec's repository"}.`,
        );
      if (row.specNumber === null)
        return yield* Effect.fail(
          new ForgeHomeError({
            reason: "launch_failed",
            message: "The note has no Forge item number.",
          }),
        );
      if (project.defaultModelSelection === null)
        return yield* Effect.fail(
          new ForgeHomeError({
            reason: "launch_failed",
            message: "The matching project has no default model.",
          }),
        );
      yield* sql`UPDATE build_send_back_deliveries SET delivered_thread_id = ${fallbackId} WHERE finding_id = ${row.findingId}`;
      yield* ThreadMessageIntake.launchThread({
        commandId: CommandId.make(fallbackId),
        threadId: ThreadId.make(fallbackId),
        projectId: project.id,
        title: row.specLabel,
        modelSelection: project.defaultModelSelection,
        // The project's own default, as any new thread there gets: Forge never asks to babysit it.
        runtimeMode: resolveProjectSettings(yield* settings.getSettings, project.id, project)
          .settings.defaultRuntimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "worktree", baseRef: "HEAD", forgeItem: row.specNumber },
        initialMessage: {
          messageId: MessageId.make(`build-send-back:${row.findingId}`),
          text,
          attachments: [],
        },
        createdBy: "user",
        creationSource: "server",
      }).pipe(
        Effect.provideService(ThreadLaunch.ThreadLaunchService, launches),
        Effect.provideContext(launchContext),
      );
      return { state: "delivered" as const, detail: null };
    }
    if (shell === null || target === undefined)
      return yield* undeliverable("The lead thread no longer exists.");
    const threadId = ThreadId.make(target);
    yield* sql`UPDATE build_send_back_deliveries SET delivered_thread_id = ${threadId} WHERE finding_id = ${row.findingId}`;
    const id = `build-send-back:${row.findingId}`;
    // The command id is the finding's, so sending again after a crash replays the first send.
    yield* threads.sendToThread({
      projectId: shell.projectId,
      commandId: CommandId.make(id),
      threadId,
      messageId: MessageId.make(id),
      text,
      attachments: [],
      // Never interrupts a running tool; an idle thread starts a turn at once.
      mode: "queue",
      createdBy: "user",
      creationSource: "server",
    });
    return { state: "delivered" as const, detail: null };
  });

  /** Takes a row as far as it goes; true when HQ has accepted its report. */
  const settle = (row: DeliveryRow) =>
    lock.withLock(
      `delivery:${row.findingId}`,
      Effect.gen(function* () {
        const connected = yield* hq.read.pipe(Effect.orElseSucceed(() => null));
        // A finding recorded at an address Weave has moved on from is this Weave's to settle.
        if (connected === null || !sameHqAddress(row.hqOrigin, connected.origin)) return false;
        let state = row.state;
        let detail = row.detail;
        if (state === "pending") {
          const outcome = yield* deliver(row).pipe(
            Effect.catchTags({
              ThreadManagementThreadArchivedError: () =>
                row.claimed === 0
                  ? Effect.succeed({
                      state: "undeliverable" as const,
                      detail: "The lead thread is archived or gone.",
                    })
                  : deliver({ ...row, deliveredThreadId: `build-note:${row.findingId}` }),
              ThreadManagementThreadNotFoundError: () =>
                row.claimed === 0
                  ? Effect.succeed({
                      state: "undeliverable" as const,
                      detail: "The lead thread is archived or gone.",
                    })
                  : deliver({ ...row, deliveredThreadId: `build-note:${row.findingId}` }),
              // Retrying cannot give the project a slipjay.json.
              ThreadLaunchForgeItemError: (error) =>
                Effect.succeed({ state: "undeliverable" as const, detail: error.message }),
            }),
            Effect.option,
          );
          // A failure to write the thread stays pending: the next pass sends under the same id.
          if (Option.isNone(outcome)) return false;
          state = outcome.value.state;
          detail = outcome.value.detail;
          yield* sql`UPDATE build_send_back_deliveries SET state = ${state}, detail = ${detail}
            WHERE finding_id = ${row.findingId}`;
        }
        if (row.reportedAt !== null) return true;
        // Reported only to the HQ that recorded it; after reconnecting elsewhere it waits for that one.
        const [destination] = yield* sql<{
          threadId: string | null;
        }>`SELECT delivered_thread_id AS "threadId" FROM build_send_back_deliveries WHERE finding_id = ${row.findingId}`;
        const response = yield* post(
          {
            action: "delivery",
            findingId: row.findingId,
            state,
            ...(row.claimed === 0
              ? {}
              : {
                  environmentId,
                  ...(destination?.threadId == null
                    ? {}
                    : {
                        thread: {
                          harness: "t3code",
                          sessionRef: `${environmentId}/${destination.threadId}`,
                        },
                      }),
                }),
            ...(detail === null ? {} : { detail }),
          },
          row.hqOrigin,
        ).pipe(Effect.option);
        // A duplicate means HQ already has this report. A note delivered or claimed elsewhere since,
        // say after "Start a new thread instead", is no longer this environment's to report.
        const accepted =
          Option.isSome(response) &&
          ((response.value.status === 200 &&
            Option.exists(response.value.outcome, (outcome) => outcome.status === "succeeded")) ||
            Option.exists(
              response.value.outcome,
              (outcome) =>
                outcome.status === "duplicate" ||
                outcome.code === "note_claimed_elsewhere" ||
                outcome.code === "note_delivered",
            ));
        if (!accepted) return false;
        const at = yield* isoNow;
        yield* sql`UPDATE build_send_back_deliveries SET reported_at = ${at}
          WHERE finding_id = ${row.findingId}`;
        return true;
      }),
    );

  const collectNotes = Effect.fn("ForgeHome.collectNotes")(
    function* () {
      const connected = yield* hq.read.pipe(Effect.orElseSucceed(() => null));
      if (connected === null) return;
      const supported = yield* probe();
      if (!supported.notes) return;
      const response = yield* post({ action: "notes", undelivered: true }, connected.origin);
      const decoded = response.outcome.pipe(
        Option.filter((o) => response.status === 200 && o.status === "succeeded"),
        Option.flatMap((o) => decodeNotes(o.value)),
      );
      if (Option.isNone(decoded))
        return yield* Effect.fail(
          new ForgeHomeError({
            reason: "launch_failed",
            message: "Weave could not read undelivered notes.",
          }),
        );
      const notes = "notes" in decoded.value ? decoded.value.notes : decoded.value;
      for (const note of notes) {
        if (note.claim !== null && note.claim.environmentId !== environmentId) continue;
        const lead = note.leadThread === null ? null : leadThreadOf(note.leadThread);
        if (lead !== null) {
          if (lead.environmentId !== null && lead.environmentId !== environmentId) continue;
          if (lead.environmentId === null) {
            const shell = yield* threads.getThreadShell(ThreadId.make(lead.threadId));
            if (shell === null || shell.deletedAt !== null) continue;
          }
        }
        const claim = yield* post(
          { action: "claim", noteId: note.id, environmentId },
          response.origin,
        );
        if (!Option.exists(claim.outcome, (o) => claim.status === 200 && o.status === "succeeded"))
          continue;
        yield* enqueue({
          findingId: note.id,
          specLabel: note.spec.ref || `#${note.spec.number}`,
          note: note.note,
          lead: note.leadThread,
          hqOrigin: response.origin,
          noteKind: note.kind,
          decisionLabel: note.decision
            ? `${note.decision.ref || `#${note.decision.number}`} “${note.decision.title}”`
            : null,
          specProject: note.spec.project,
          specNumber: note.spec.number,
          claimed: true,
        });
      }
    },
    (effect) => lock.withLock("notes", effect),
  );

  const settleDeliveries: ForgeHome["Service"]["settleDeliveries"] = Effect.gen(function* () {
    let failed = 0;
    yield* collectNotes().pipe(
      Effect.catchCause((cause) => {
        failed += 1;
        return Effect.logWarning("Could not collect Forge notes", cause);
      }),
    );
    const rows = yield* unreportedDeliveries;
    for (const row of rows) {
      const done = yield* settle(row).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not deliver a Send back", {
            findingId: row.findingId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!done) failed += 1;
    }
    return { failed };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not read the Send back outbox", cause).pipe(
        Effect.as({ failed: 1 }),
      ),
    ),
  );

  const enqueue = Effect.fn("ForgeHome.enqueue")(function* (input: {
    readonly findingId: string;
    readonly specLabel: string;
    readonly note: string;
    readonly lead: { readonly harness: string; readonly sessionRef: string } | null;
    readonly hqOrigin: string;
    readonly noteKind?: "send_back" | "answer" | "decision";
    readonly decisionLabel?: string | null;
    readonly specProject?: string | null;
    readonly specNumber?: number;
    readonly claimed?: boolean;
  }) {
    const at = yield* isoNow;
    // Keyed by finding, so HQ answering the same Send back twice still means one delivery. A claimed
    // note HQ still lists as pending after this environment reported it undeliverable, or with another lead, was
    // sent to a new thread ("Start a new thread instead"): it starts over.
    yield* sql`INSERT INTO build_send_back_deliveries
      (finding_id, spec_label, note, lead_harness, lead_session_ref, state, created_at, hq_origin,
        note_kind, decision_label, spec_project, spec_number, claimed)
      VALUES (${input.findingId}, ${input.specLabel}, ${input.note},
        ${input.lead?.harness ?? null}, ${input.lead?.sessionRef ?? null}, 'pending', ${at},
        ${input.hqOrigin}, ${input.noteKind ?? "send_back"}, ${input.decisionLabel ?? null}, ${input.specProject ?? null},
        ${input.specNumber ?? null}, ${input.claimed ? 1 : 0})
      ON CONFLICT (finding_id) DO UPDATE SET
        lead_harness = excluded.lead_harness, lead_session_ref = excluded.lead_session_ref,
        state = 'pending', detail = NULL, reported_at = NULL, delivered_thread_id = NULL,
        hq_origin = excluded.hq_origin
      WHERE excluded.claimed = 1 AND build_send_back_deliveries.claimed = 1 AND (
        (build_send_back_deliveries.state = 'undeliverable'
          AND build_send_back_deliveries.reported_at IS NOT NULL)
        OR build_send_back_deliveries.lead_session_ref IS NOT excluded.lead_session_ref)`;
  });

  const decide: ForgeHome["Service"]["decide"] = Effect.fn("ForgeHome.decide")(function* (input) {
    const answered = yield* post({
      action: "decide",
      specId: input.specId,
      decision: input.decision,
      card: input.card,
      ...(input.note === undefined ? {} : { note: input.note }),
      via: { client: "t3", environmentId },
    }).pipe(Effect.result);
    if (answered._tag === "Failure" && answered.failure.reason === "not_connected")
      return yield* notConnected;
    const response = answered._tag === "Success" ? Option.some(answered.success) : Option.none();
    const origin = Option.isSome(response) ? response.value.origin : null;
    const refused = (
      message: string,
      state: ForgeHomeState = stateOf(origin, "ready", null, null),
    ) =>
      readHome.pipe(
        Effect.map((fresh) => ({
          outcome: "refused" as const,
          message,
          state: fresh.status === "ready" ? fresh : state,
        })),
      );
    if (Option.isNone(response))
      return yield* refused("Weave could not be reached. Try again shortly.");
    const { status, outcome } = response.value;
    if (status === 401) {
      yield* forget;
      return {
        outcome: "refused" as const,
        message:
          "Weave refused T3's delegation: it expired or was revoked. Reconnect it in Settings → Integrations → Weave → Connect to Weave.",
        state: stateOf(origin, "invalid_token", null, null),
      };
    }
    if (status === 200 && Option.exists(outcome, (found) => found.status === "succeeded")) {
      const decided = outcome.pipe(Option.flatMap((found) => decodeDecided(found.value)));
      yield* forget;
      const supported = yield* probe().pipe(
        Effect.orElseSucceed(() => ({ answer: false, notes: false })),
      );
      if (!supported.notes && Option.isSome(decided) && decided.value.finding !== null) {
        // Delivery never fails the decision: HQ has it, and the outbox keeps trying.
        yield* enqueue({
          findingId: decided.value.finding.id,
          specLabel: decided.value.spec.ref || `#${decided.value.spec.number}`,
          note: decided.value.finding.note,
          lead: decided.value.leadThread,
          hqOrigin: response.value.origin,
        }).pipe(
          Effect.andThen(settleDeliveries),
          Effect.catchCause((cause) => Effect.logWarning("Could not queue a Send back", cause)),
        );
      }
      if (supported.notes) yield* settleDeliveries;
      return { outcome: "decided" as const, message: null, state: yield* readHome };
    }
    const code = Option.getOrUndefined(Option.map(outcome, (found) => found.code ?? undefined));
    if (code === "acceptance_card_stale") {
      yield* forget;
      return {
        outcome: "stale" as const,
        message: "This Spec changed after the card was shown. The card now is the current one.",
        state: yield* readHome,
      };
    }
    return yield* refused(hqErrorMessage(code));
  });

  const answer: ForgeHome["Service"]["answer"] = Effect.fn("ForgeHome.answer")(function* (input) {
    const state = yield* readHome;
    if (state.status === "not_connected") return yield* notConnected;
    const supported = yield* probe().pipe(
      Effect.orElseSucceed(() => ({ answer: false, notes: false })),
    );
    if (!supported.answer)
      return {
        outcome: "refused",
        message: "This Weave does not support answering holds from T3 yet.",
        state,
      };
    const response = yield* post({
      action: "answer",
      ...input,
      via: { client: "t3", environmentId },
    }).pipe(Effect.option);
    if (
      Option.isSome(response) &&
      response.value.status === 200 &&
      Option.exists(response.value.outcome, (o) => o.status === "succeeded")
    ) {
      yield* forget;
      yield* settleDeliveries;
      return { outcome: "decided", message: null, state: yield* readHome };
    }
    const code = Option.isSome(response)
      ? Option.getOrUndefined(Option.map(response.value.outcome, (o) => o.code))
      : undefined;
    return { outcome: "refused", message: hqErrorMessage(code), state };
  });

  // Retries what a restart or an outage left behind: first at once, then with backoff while any
  // report fails, otherwise at the Forge re-read cadence.
  yield* forkParked(
    Effect.gen(function* () {
      let backoff = DELIVERY_RETRY_MS;
      while (true) {
        const { failed } = yield* settleDeliveries;
        yield* Effect.sleep(Duration.millis(failed === 0 ? BUILD_REREAD_INTERVAL_MS : backoff));
        backoff =
          failed === 0 ? DELIVERY_RETRY_MS : Math.min(backoff * 2, BUILD_MAX_REREAD_INTERVAL_MS);
      }
    }),
  );

  // #4070's separate decision token is retired: the HQ connection decides now.
  yield* store
    .remove(RETIRED_STORE_NAME)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not remove T3's retired Forge decision token", cause),
      ),
    );

  return ForgeHome.of({ read: readHome, refreshed, decide, answer, settleDeliveries });
});

export const layer = Layer.effect(ForgeHome, make);
