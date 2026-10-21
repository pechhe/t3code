/**
 * Build Home for T3's Build button (pechhe/yardsmith Specs #4070, #4367). It reads and decides
 * through T3's one HQ connection: `HqAgentConnections.decide` presents the person's delegation to
 * HQ's decisions endpoint, which allows only Accept, Send back and the reads that refresh the
 * cards, as the person. No client, agent, prompt, workspace or log ever sees the delegation.
 *
 * A Send back is delivered to the lead thread that reported the Spec's newest session, exactly
 * once: the note is queued as a user message under a command id derived from HQ's finding id, so
 * a retry or a restart replays the same command, and an outbox row keyed by that id lives until
 * HQ has accepted the delivery report.
 */
import {
  BuildHomeError,
  type BuildHome as BuildHomeView,
  type BuildHomeDecideInput,
  type BuildHomeDecideResult,
  type BuildHomeFixInput,
  type BuildHomeFixResult,
  type BuildHomeItem,
  type BuildHomeNeed,
  type BuildHomeState,
  CommandId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { buildItemUrl } from "@t3tools/shared/buildLinks";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as Project from "../project/ProjectService.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import { forkParked } from "../serverActivation.ts";
import {
  BUILD_MAX_REREAD_INTERVAL_MS,
  BUILD_REREAD_INTERVAL_MS,
  fingerprintOf,
  nextInterval,
  type ReadCadence,
} from "./BuildWorkItems.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";

/** Where #4070 kept a separate decision token; removed at startup now the HQ connection decides. */
const RETIRED_STORE_NAME = "hq-build-decisions";
/** A delivery that fails is tried again after this, doubling to the Build re-read cap. */
const DELIVERY_RETRY_MS = 5_000;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** HQ's own `Item` fields Build Home names a Spec by. The rest of its view is left out. */
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
  }),
});
const HqFindingNeed = Schema.Struct({
  kind: Schema.Literal("finding"),
  spec: HqItem,
  finding: Schema.Unknown,
});
const HqHoldNeed = Schema.Struct({
  kind: Schema.Literal("hold"),
  item: HqItem,
  hold: Schema.Struct({ kind: Schema.String, note: Schema.String }),
});
const HqDecisionNeed = Schema.Struct({ kind: Schema.Literal("decision"), decision: HqItem });
const HqHome = Schema.Struct({
  needsYou: Schema.Array(Schema.Unknown),
  stuck: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      spec: HqItem,
      blocker: Schema.String,
      fix: Schema.String,
      since: Schema.String,
      prompt: Schema.String,
    }),
  ),
  inProgress: Schema.Array(Schema.Struct({ spec: HqItem, liveLead: Schema.Boolean })),
  count: Schema.Int,
});
const decodeHome = Schema.decodeUnknownOption(HqHome);
const decodeAcceptance = Schema.decodeUnknownOption(HqAcceptance);
const decodeFindingNeed = Schema.decodeUnknownOption(HqFindingNeed);
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

/** A first line of whatever text a review finding carries; Build's finding shape is its own. */
const textOf = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) return null;
  for (const key of ["title", "summary", "text", "description"]) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === "string" && field !== "") return field;
  }
  return null;
};

const itemOf = (item: typeof HqItem.Type): BuildHomeItem => ({
  id: item.id,
  number: item.number,
  ref: item.ref ? item.ref : null,
  title: item.title,
  status: item.status,
});

const refusalMessages: Record<string, string> = {
  send_back_note_required: "Add a note to send this back.",
  acceptance_card_stale: "This Spec changed after the card was shown.",
  hq_access_denied: "HQ no longer lets this account use Build.",
};

const hqErrorMessage = (code: string | undefined) =>
  (code === undefined ? undefined : refusalMessages[code]) ??
  (code === undefined ? "HQ refused that." : `HQ refused that (${code}).`);

export class BuildHome extends Context.Service<
  BuildHome,
  {
    /** Build Home as the button shows it; HQ is asked at most as often as Build items are. */
    readonly read: Effect.Effect<BuildHomeState>;
    /** Accept or Send back as the person; a Send back's note is then delivered to the lead. */
    readonly decide: (
      input: BuildHomeDecideInput,
    ) => Effect.Effect<BuildHomeDecideResult, BuildHomeError>;
    /** "Do it": a new thread for the Spec, bound to its Build item, with the stuck line's prompt. */
    readonly fix: (input: BuildHomeFixInput) => Effect.Effect<BuildHomeFixResult, BuildHomeError>;
    /** Delivers and reports every Send back not yet reported; the retry loop runs this. */
    readonly settleDeliveries: Effect.Effect<{ readonly failed: number }>;
  }
>()("t3/hq/BuildHome") {}

interface CachedHome extends ReadCadence {
  readonly key: string;
  readonly state: BuildHomeState;
  readonly prompts: ReadonlyMap<string, string>;
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
}

/**
 * The T3 thread a Build lead session names (Spec #4070): T3 leads report harness `t3code` with
 * their thread id as `sessionRef`; `t3` with `<environment>/<thread>` also names one. Null for any
 * other harness or form; `environmentId` is null for a bare thread id, meaning this environment.
 */
export const leadThreadOf = (lead: { readonly harness: string; readonly sessionRef: string }) => {
  if (lead.harness !== "t3code" && lead.harness !== "t3") return null;
  const parts = lead.sessionRef.split("/");
  if (parts.some((part) => part === "") || parts.length > 2) return null;
  return parts.length === 2
    ? { environmentId: parts[0]!, threadId: parts[1]! }
    : { environmentId: null, threadId: parts[0]! };
};

export const sendBackMessageText = (input: { readonly specLabel: string; readonly note: string }) =>
  [
    `Your owner sent ${input.specLabel} back from Build.`,
    "",
    `Their note: ${input.note}`,
    "",
    `This is a blocking finding on ${input.specLabel}: fix what it says and land the change, then it can be judged again.`,
  ].join("\n");

const notConnected = new BuildHomeError({
  reason: "not_connected",
  message:
    "T3 is not connected to YardSmith HQ. Create a delegation in HQ Settings → Connections → T3 agents, then ask any thread to connect T3 to HQ with it.",
});

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const hq = yield* HqAgentConnections.HqAgentConnections;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* Project.ProjectService;
  const workspaces = yield* WorkspaceProvider.WorkspaceProvider;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const launchContext = yield* Effect.context<FileSystem.FileSystem | ServerConfig.ServerConfig>();
  const lock = yield* KeyedLock.make<string>();
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
    status: BuildHomeState["status"],
    home: BuildHomeView | null,
    readAt: string | null,
  ): BuildHomeState => ({
    status,
    origin,
    buildUrl: origin === null ? null : `${origin}/build`,
    home,
    readAt,
  });

  const viewOf = (
    home: typeof HqHome.Type,
    origin: string,
  ): { readonly view: BuildHomeView; readonly prompts: Map<string, string> } => {
    const needsYou = home.needsYou.flatMap((raw): ReadonlyArray<BuildHomeNeed> => {
      const acceptance = decodeAcceptance(raw);
      if (Option.isSome(acceptance)) {
        const spec = acceptance.value.spec;
        const rows = spec.readiness.rows;
        const card = spec.card ?? null;
        return [
          {
            kind: "acceptance",
            spec: itemOf(spec),
            url: buildItemUrl(origin, spec.number),
            repositories: [...new Set((card?.published ?? []).map((source) => source.repository))],
            checks: spec.readiness.checks ?? [],
            reviewSummary: spec.reviewSummary ?? null,
            tryIt: spec.tryIt ?? null,
            rows,
            card,
          },
        ];
      }
      const finding = decodeFindingNeed(raw);
      if (Option.isSome(finding))
        return [
          {
            kind: "finding",
            spec: itemOf(finding.value.spec),
            url: buildItemUrl(origin, finding.value.spec.number),
            detail: textOf(finding.value.finding),
          },
        ];
      const hold = decodeHoldNeed(raw);
      if (Option.isSome(hold))
        return [
          {
            kind: "hold",
            spec: itemOf(hold.value.item),
            url: buildItemUrl(origin, hold.value.item.number),
            detail: hold.value.hold.note === "" ? hold.value.hold.kind : hold.value.hold.note,
          },
        ];
      const decision = decodeDecisionNeed(raw);
      return Option.isSome(decision)
        ? [
            {
              kind: "decision",
              spec: itemOf(decision.value.decision),
              url: buildItemUrl(origin, decision.value.decision.number),
              detail: null,
            },
          ]
        : [];
    });
    return {
      view: {
        needsYou,
        stuck: home.stuck.map(({ prompt: _prompt, ...line }) => ({
          ...line,
          spec: itemOf(line.spec),
        })),
        inProgress: home.inProgress.map((entry) => ({
          spec: itemOf(entry.spec),
          liveLead: entry.liveLead,
        })),
        count: home.count,
      },
      prompts: new Map(home.stuck.map((line) => [`${line.spec.number}:${line.kind}`, line.prompt])),
    };
  };

  const isoNow = Clock.currentTimeMillis.pipe(
    Effect.map((now) => DateTime.formatIso(DateTime.makeUnsafe(now))),
  );

  /** Asks HQ for Home unless the last answer is still within its cadence. */
  const readHome = lock.withLock(
    "home",
    Effect.gen(function* () {
      const connected = yield* hq.read.pipe(Effect.orElseSucceed(() => null));
      if (connected === null) {
        cached = undefined;
        return stateOf(null, "not_connected", null, null);
      }
      const now = yield* Clock.currentTimeMillis;
      const writeVersion = yield* hq.buildWriteVersion;
      const previous = cached?.key === connected.connection ? cached : undefined;
      if (
        previous !== undefined &&
        previous.writeVersion === writeVersion &&
        now - previous.attemptedAt < previous.intervalMs
      )
        return previous.state;
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
        const { view, prompts } = viewOf(value.value, origin);
        // HQ counts every need; one T3 cannot read would otherwise vanish from the cards silently.
        const dropped = value.value.needsYou.length - view.needsYou.length;
        if (dropped > 0)
          yield* Effect.logWarning("Build Home has needs T3 could not read", {
            dropped,
            kinds: value.value.needsYou.map((need) =>
              typeof need === "object" && need !== null && "kind" in need ? String(need.kind) : "?",
            ),
          });
        const fingerprint = fingerprintOf(view);
        cached = {
          key,
          attemptedAt: now,
          writeVersion,
          fingerprint,
          intervalMs: nextInterval(fresh, fingerprint, writeVersion),
          prompts,
          state: stateOf(origin, "ready", view, DateTime.formatIso(DateTime.makeUnsafe(now))),
        };
        return cached.state;
      }
      const refused = Option.isSome(response) && response.value.status === 401;
      if (!refused)
        yield* Effect.logWarning("Could not read Build Home from HQ", {
          status: Option.isSome(response) ? response.value.status : "unreachable",
        });
      const state = refused
        ? stateOf(origin, "invalid_token", null, null)
        : stateOf(origin, "unavailable", fresh?.state.home ?? null, fresh?.state.readAt ?? null);
      cached = {
        key,
        attemptedAt: now,
        writeVersion,
        fingerprint: undefined,
        intervalMs: BUILD_REREAD_INTERVAL_MS,
        prompts: fresh?.prompts ?? new Map(),
        state,
      };
      return state;
    }),
  );

  /** A decision changes what Home says, so the next read asks HQ. */
  const forget = Effect.sync(() => {
    cached = undefined;
  });

  // ---------------------------------------------------------------------------------------
  // Send back delivery

  const unreportedDeliveries = sql<DeliveryRow>`
      SELECT finding_id AS "findingId", spec_label AS "specLabel", note,
        lead_harness AS "leadHarness", lead_session_ref AS "leadSessionRef", state, detail,
        reported_at AS "reportedAt", hq_origin AS "hqOrigin"
      FROM build_send_back_deliveries
      WHERE reported_at IS NULL
      ORDER BY created_at
    `;

  /** The thread a lead's session names, or why there is none this environment can write to. */
  const deliver = (row: DeliveryRow) =>
    Effect.gen(function* () {
      const undeliverable = (detail: string) =>
        Effect.succeed({ state: "undeliverable" as const, detail });
      if (row.leadHarness === null || row.leadSessionRef === null)
        return yield* undeliverable("Build had no lead session for this Spec.");
      const lead = leadThreadOf({ harness: row.leadHarness, sessionRef: row.leadSessionRef });
      if (lead === null) return yield* undeliverable("The lead is not a T3 thread.");
      if (lead.environmentId !== null && lead.environmentId !== environmentId)
        return yield* undeliverable("The lead thread is in another T3 environment.");
      const threadId = ThreadId.make(lead.threadId);
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null)
        return yield* undeliverable("The lead thread no longer exists.");
      if (shell.archivedAt !== null) return yield* undeliverable("The lead thread is archived.");
      const id = `build-send-back:${row.findingId}`;
      // The command id is the finding's, so sending again after a crash replays the first send.
      yield* threads.sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(id),
        threadId,
        messageId: MessageId.make(id),
        text: sendBackMessageText(row),
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
        let state = row.state;
        let detail = row.detail;
        if (state === "pending") {
          const outcome = yield* deliver(row).pipe(
            Effect.catchTag(
              ["ThreadManagementThreadArchivedError", "ThreadManagementThreadNotFoundError"],
              () =>
                Effect.succeed({
                  state: "undeliverable" as const,
                  detail: "The lead thread is archived or gone.",
                }),
            ),
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
        const response = yield* post(
          {
            action: "delivery",
            findingId: row.findingId,
            state,
            ...(detail === null ? {} : { detail }),
          },
          row.hqOrigin,
        ).pipe(Effect.option);
        // A duplicate means HQ already has this report.
        const accepted =
          Option.isSome(response) &&
          (response.value.status === 200 ||
            Option.exists(response.value.outcome, (outcome) => outcome.status === "duplicate"));
        if (!accepted) return false;
        const at = yield* isoNow;
        yield* sql`UPDATE build_send_back_deliveries SET reported_at = ${at}
          WHERE finding_id = ${row.findingId}`;
        return true;
      }),
    );

  const settleDeliveries: BuildHome["Service"]["settleDeliveries"] = Effect.gen(function* () {
    const rows = yield* unreportedDeliveries;
    let failed = 0;
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

  const enqueue = Effect.fn("BuildHome.enqueue")(function* (input: {
    readonly findingId: string;
    readonly specLabel: string;
    readonly note: string;
    readonly lead: { readonly harness: string; readonly sessionRef: string } | null;
    readonly hqOrigin: string;
  }) {
    const at = yield* isoNow;
    // Keyed by finding, so HQ answering the same Send back twice still means one delivery.
    yield* sql`INSERT OR IGNORE INTO build_send_back_deliveries
      (finding_id, spec_label, note, lead_harness, lead_session_ref, state, created_at, hq_origin)
      VALUES (${input.findingId}, ${input.specLabel}, ${input.note},
        ${input.lead?.harness ?? null}, ${input.lead?.sessionRef ?? null}, 'pending', ${at},
        ${input.hqOrigin})`;
  });

  // ---------------------------------------------------------------------------------------

  const decide: BuildHome["Service"]["decide"] = Effect.fn("BuildHome.decide")(function* (input) {
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
      state: BuildHomeState = stateOf(origin, "ready", null, null),
    ) =>
      readHome.pipe(
        Effect.map((fresh) => ({
          outcome: "refused" as const,
          message,
          state: fresh.status === "ready" ? fresh : state,
        })),
      );
    if (Option.isNone(response))
      return yield* refused("HQ could not be reached. Try again shortly.");
    const { status, outcome } = response.value;
    if (status === 401) {
      yield* forget;
      return {
        outcome: "refused" as const,
        message:
          "HQ refused T3's delegation: it expired or was revoked. Create a new one in HQ Settings → Connections → T3 agents, then ask any thread to reconnect T3 to HQ with it.",
        state: stateOf(origin, "invalid_token", null, null),
      };
    }
    if (status === 200 && Option.exists(outcome, (found) => found.status === "succeeded")) {
      const decided = outcome.pipe(Option.flatMap((found) => decodeDecided(found.value)));
      yield* forget;
      if (Option.isSome(decided) && decided.value.finding !== null) {
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

  const fix: BuildHome["Service"]["fix"] = Effect.fn("BuildHome.fix")(function* (input) {
    const state = yield* readHome;
    if (state.status === "not_connected") return yield* notConnected;
    const prompt = cached?.prompts.get(`${input.specNumber}:${input.kind}`) ?? undefined;
    const line = state.home?.stuck.find(
      (stuck) => stuck.spec.number === input.specNumber && stuck.kind === input.kind,
    );
    if (prompt === undefined || line === undefined)
      return yield* new BuildHomeError({
        reason: "stuck_line_not_found",
        message: "That item is no longer stuck. Build Home has been refreshed.",
      });
    const failure = (reason: BuildHomeError["reason"], message: string) =>
      new BuildHomeError({ reason, message });
    const shell = yield* threads
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError(() => failure("launch_failed", "T3 could not read the thread.")));
    if (shell === null || shell.deletedAt !== null)
      return yield* failure("thread_not_found", `Thread ${input.threadId} was not found.`);
    const project = yield* projects.getById(shell.projectId).pipe(
      Effect.mapError(() => failure("launch_failed", "T3 could not read the project.")),
      Effect.map(Option.getOrUndefined),
    );
    // The same rule t3_thread_launch applies to buildItem: the item's workspace is a SlipJay one.
    if (project === undefined || (yield* workspaces.resolve(project.workspaceRoot)) !== "slipjay")
      return yield* failure(
        "launch_failed",
        "This thread's project has no slipjay.json, so it cannot open a workspace for a Build item.",
      );
    const commandId = CommandId.make(
      `build-home:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
    );
    const threadId = ThreadId.make(commandId);
    const label = line.spec.ref || `#${line.spec.number}`;
    const result = yield* ThreadMessageIntake.launchThread({
      commandId,
      threadId,
      projectId: shell.projectId,
      title: `${label}: ${line.fix}`.slice(0, 80),
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      workspaceStrategy: { type: "worktree", baseRef: "HEAD", buildItem: input.specNumber },
      initialMessage: {
        messageId: MessageId.make(commandId),
        senderThreadId: input.threadId,
        text: prompt,
        attachments: [],
      },
      createdBy: "user",
      creationSource: "web",
    }).pipe(
      Effect.provideService(ThreadLaunch.ThreadLaunchService, launches),
      Effect.provideContext(launchContext),
      Effect.mapError((error) =>
        failure(
          "launch_failed",
          error._tag === "ThreadManagementProviderInstanceDisabledError"
            ? error.message
            : "T3 could not start the thread.",
        ),
      ),
    );
    return { threadId: result.threadId };
  });

  // Retries what a restart or an outage left behind: first at once, then with backoff while any
  // report fails, otherwise at the Build re-read cadence.
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
        Effect.logWarning("Could not remove T3's retired Build decision token", cause),
      ),
    );

  return BuildHome.of({ read: readHome, decide, fix, settleDeliveries });
});

export const layer = Layer.effect(BuildHome, make);
