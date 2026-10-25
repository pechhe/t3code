import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  SlipJayRunnerDeploy,
  SlipJayRunnerOperation,
  SlipJayRunnerOverview,
  VcsSlipJayLandingDetailResult,
  VcsStatusSlipJayLanding,
} from "@t3tools/contracts";

/**
 * SlipJay landing state as `slipjay watch --json` reports it, reduced to what a
 * workspace's status shows. Only landing operations are tracked; releases, deploys
 * and resets share the runner but never belong to a workspace.
 */
export interface TrackedLanding {
  readonly operationId: string;
  /** SlipJay's repository key, lowercase `owner/name`. */
  readonly repo: string;
  readonly changeId: string;
  readonly status: VcsStatusSlipJayLanding["status"];
  readonly stage: string;
  readonly commitId?: string;
  readonly reason?: string;
  /** The Build item SlipJay recorded the landing as delivering, kept once the queue drops it. */
  readonly spec?: number;
  /** SlipJay's `<host>:<workspace>` label, known only from a snapshot that listed it active. */
  readonly submittedBy?: string;
}

export interface LandingWatchState {
  /** The watch is connected and its snapshot and replay are applied. */
  readonly connected: boolean;
  /** The last applied global event sequence, for resuming a restarted watch. */
  readonly cursor: number;
  /** In submission order, oldest first. */
  readonly operations: ReadonlyMap<string, TrackedLanding>;
}

export const initialLandingWatchState: LandingWatchState = {
  connected: false,
  cursor: 0,
  operations: new Map(),
};

/**
 * What a watch-state change concerns: a landing of `changeId` in `repository`, or,
 * when the watch connected or dropped, every landing (`repository: null`).
 */
export type LandingChange =
  | { readonly repository: string; readonly changeId: string }
  | { readonly repository: null };

/** The landings that differ between two watch states, one change per repository and change. */
export function landingChanges(
  before: LandingWatchState,
  after: LandingWatchState,
): ReadonlyArray<LandingChange> {
  if (before.connected !== after.connected) return [{ repository: null }];
  if (before.operations === after.operations) return [];
  const changes = new Map<string, LandingChange>();
  for (const id of new Set([...before.operations.keys(), ...after.operations.keys()])) {
    const previous = before.operations.get(id);
    const next = after.operations.get(id);
    const landing = next ?? previous;
    if (previous === next || landing === undefined) continue;
    changes.set(`${landing.repo} ${landing.changeId}`, {
      repository: landing.repo,
      changeId: landing.changeId,
    });
  }
  return [...changes.values()];
}

/** Terminal landings kept after they finish, so a thread can still show the result. */
const RETAINED_TERMINAL_LANDINGS = 200;

const WatchOperation = Schema.Struct({
  id: Schema.String,
  kind: Schema.optional(Schema.String),
  repo: Schema.String,
  changeId: Schema.optional(Schema.String),
  stage: Schema.String,
  status: Schema.optional(Schema.String),
  position: Schema.optional(Schema.Number),
  submittedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  stageStartedAt: Schema.optional(Schema.String),
  runs: Schema.optional(Schema.Array(Schema.Struct({ startedAt: Schema.optional(Schema.String) }))),
  timing: Schema.optional(
    Schema.Struct({ medianMs: Schema.optional(Schema.NullOr(Schema.Number)) }),
  ),
  commitId: Schema.optional(Schema.String),
  submittedBy: Schema.optional(Schema.String),
  environment: Schema.optional(Schema.String),
  spec: Schema.optional(Schema.Number),
});
type WatchOperation = typeof WatchOperation.Type;
const decodeWatchOperation = Schema.decodeUnknownOption(WatchOperation);
const watchOperations = (entries: ReadonlyArray<unknown> | undefined) =>
  (entries ?? []).flatMap((entry) => Option.toArray(decodeWatchOperation(entry)));

const WatchEvent = Schema.Struct({
  type: Schema.String,
  kind: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.String),
  changeId: Schema.optional(Schema.String),
  stage: Schema.optional(Schema.String),
  commitId: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});

const WatchEnvelope = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    snapshot: Schema.Struct({
      seq: Schema.Number,
      lanes: Schema.Struct({
        serial: Schema.Array(WatchOperation),
        // Read entry by entry for the overview, so one it cannot read never drops the
        // snapshot that landing tracking depends on.
        deploy: Schema.optional(Schema.Array(Schema.Unknown)),
      }),
      paused: Schema.optional(Schema.Unknown),
      lastStagingDeploys: Schema.optional(Schema.Array(Schema.Unknown)),
      recentProductionDeploys: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("event"),
    event: Schema.Struct({ seq: Schema.Number, operationId: Schema.String, event: WatchEvent }),
  }),
  Schema.Struct({
    type: Schema.Literal("connection"),
    state: Schema.Literals(["connecting", "connected", "disconnected"]),
    cursor: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal("heartbeat") }),
]);
export type WatchEnvelope = typeof WatchEnvelope.Type;
type WatchSnapshot = Extract<WatchEnvelope, { readonly type: "snapshot" }>["snapshot"];

const decodeWatchLine = Schema.decodeUnknownOption(Schema.fromJsonString(WatchEnvelope));

/** One stdout line of `slipjay watch --json`; lines of another shape are skipped. */
export const parseWatchLine = (line: string) => decodeWatchLine(line);

const LandingOutcome = Schema.Struct({
  status: Schema.String,
  stage: Schema.String,
  terminal: Schema.Boolean,
  publication: Schema.optional(Schema.Struct({ commitId: Schema.optional(Schema.String) })),
  failure: Schema.optional(
    Schema.Struct({ reason: Schema.String, stage: Schema.optional(Schema.String) }),
  ),
});
export type LandingOutcome = typeof LandingOutcome.Type;

/** `slipjay runner outcome <operation>` output, or none when it is not one. */
export const parseLandingOutcome = Schema.decodeUnknownOption(
  Schema.fromJsonString(LandingOutcome),
);

const LandingDetail = Schema.Struct({
  ...LandingOutcome.fields,
  submittedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  identity: Schema.optional(Schema.Struct({ workspace: Schema.optional(Schema.String) })),
  publication: Schema.optional(
    Schema.Struct({
      base: Schema.optional(Schema.String),
      commitId: Schema.optional(Schema.String),
    }),
  ),
  runs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        command: Schema.String,
        purpose: Schema.String,
        outcome: Schema.String,
        // Absent or null until the run finishes.
        durationMs: Schema.optional(Schema.NullOr(Schema.Number)),
        failingTests: Schema.optional(Schema.Array(Schema.String)),
        invalidated: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});
const decodeLandingDetail = Schema.decodeUnknownOption(Schema.fromJsonString(LandingDetail));

const present = <K extends string, V>(key: K, value: V | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

/**
 * A landing's detail from `slipjay runner outcome <operation>` output, or none when it is
 * not one. Runs a later attempt replaced are left out: they no longer decide the outcome.
 */
export const parseLandingDetail = (stdout: string): Option.Option<VcsSlipJayLandingDetailResult> =>
  Option.map(decodeLandingDetail(stdout), (outcome) => ({
    status: outcome.status,
    stage: outcome.stage,
    terminal: outcome.terminal,
    ...present("submittedAt", outcome.submittedAt),
    ...present("finishedAt", outcome.finishedAt),
    ...present("workspace", outcome.identity?.workspace),
    ...present("baseCommitId", outcome.publication?.base),
    ...present("commitId", outcome.publication?.commitId),
    ...(outcome.failure === undefined
      ? {}
      : {
          failure: {
            reason: outcome.failure.reason,
            ...present("stage", outcome.failure.stage),
          },
        }),
    checks: (outcome.runs ?? [])
      .filter((run) => run.invalidated !== true)
      .map((run) => ({
        command: run.command,
        purpose: run.purpose,
        outcome: run.outcome,
        ...present("durationMs", run.durationMs),
        failingTests: run.failingTests ?? [],
      })),
  }));

const isLanding = (kind: string | undefined) => kind === undefined || kind === "landing";

const withOperation = (
  state: LandingWatchState,
  landing: TrackedLanding,
): ReadonlyMap<string, TrackedLanding> => {
  const operations = new Map(state.operations);
  operations.set(landing.operationId, landing);
  const terminal = [...operations.values()].filter((entry) => entry.status !== "active");
  for (const stale of terminal.slice(0, Math.max(0, terminal.length - RETAINED_TERMINAL_LANDINGS)))
    operations.delete(stale.operationId);
  return operations;
};

const update = (
  state: LandingWatchState,
  operationId: string,
  change: (landing: TrackedLanding) => TrackedLanding,
): LandingWatchState => {
  const landing = state.operations.get(operationId);
  return landing === undefined
    ? state
    : { ...state, operations: withOperation(state, change(landing)) };
};

export interface AppliedEnvelope {
  readonly state: LandingWatchState;
  /**
   * Landings that were active but are missing from a fresh snapshot without a
   * terminal event in view: their result has to be read from the runner.
   */
  readonly vanished: ReadonlyArray<string>;
}

export function applyWatchEnvelope(
  state: LandingWatchState,
  envelope: WatchEnvelope,
): AppliedEnvelope {
  switch (envelope.type) {
    case "heartbeat":
      return { state, vanished: [] };
    case "connection":
      return {
        state: {
          ...state,
          connected: envelope.state === "connected",
          cursor: envelope.state === "connected" ? envelope.cursor : state.cursor,
        },
        vanished: [],
      };
    case "snapshot": {
      // A snapshot lists only active operations, so it never adds terminal landings to trim.
      // The watch repeats one after every heartbeat: an unchanged snapshot keeps the same
      // operations, so nothing downstream refreshes.
      const listed = new Set<string>();
      const operations = new Map(state.operations);
      let changed = false;
      for (const operation of envelope.snapshot.lanes.serial) {
        if (!isLanding(operation.kind) || operation.changeId === undefined) continue;
        listed.add(operation.id);
        const known = operations.get(operation.id);
        const spec = operation.spec ?? known?.spec;
        if (
          known?.status === "active" &&
          known.stage === operation.stage &&
          known.spec === spec &&
          known.submittedBy === operation.submittedBy
        )
          continue;
        changed = true;
        operations.set(operation.id, {
          operationId: operation.id,
          repo: operation.repo.toLowerCase(),
          changeId: operation.changeId,
          status: "active",
          stage: operation.stage,
          ...(known?.commitId === undefined ? {} : { commitId: known.commitId }),
          ...(spec === undefined ? {} : { spec }),
          ...(operation.submittedBy === undefined ? {} : { submittedBy: operation.submittedBy }),
        });
      }
      const vanished = [...operations.values()]
        .filter((landing) => landing.status === "active" && !listed.has(landing.operationId))
        .map((landing) => landing.operationId);
      return { state: changed ? { ...state, operations } : state, vanished };
    }
    case "event": {
      const { operationId, event, seq } = envelope.event;
      const advanced = { ...state, cursor: Math.max(state.cursor, seq) };
      switch (event.type) {
        case "submitted":
          if (!isLanding(event.kind) || event.repo === undefined || event.changeId === undefined)
            return { state: advanced, vanished: [] };
          return {
            state: {
              ...advanced,
              operations: withOperation(advanced, {
                operationId,
                repo: event.repo.toLowerCase(),
                changeId: event.changeId,
                status: "active",
                stage: "queued",
              }),
            },
            vanished: [],
          };
        case "stage":
          return {
            state: update(advanced, operationId, (landing) =>
              landing.status === "active" && event.stage !== undefined
                ? { ...landing, stage: event.stage }
                : landing,
            ),
            vanished: [],
          };
        case "landed":
          return {
            state: update(advanced, operationId, (landing) => ({
              ...landing,
              status: "landed",
              ...(event.commitId === undefined ? {} : { commitId: event.commitId }),
            })),
            vanished: [],
          };
        case "failed":
        case "cancelled":
        case "declined": {
          const status = event.type;
          return {
            state: update(advanced, operationId, (landing) => ({
              ...landing,
              status,
              ...(event.stage === undefined ? {} : { stage: event.stage }),
              ...(event.reason === undefined ? {} : { reason: event.reason }),
            })),
            vanished: [],
          };
        }
        case "superseded": {
          // A newer submission of the same change replaces this one.
          const operations = new Map(advanced.operations);
          operations.delete(operationId);
          return { state: { ...advanced, operations }, vanished: [] };
        }
        default:
          return { state: advanced, vanished: [] };
      }
    }
  }
}

/** Settles a vanished landing from its retained outcome, or marks it unknown without one. */
export function applyLandingOutcome(
  state: LandingWatchState,
  operationId: string,
  outcome: LandingOutcome | undefined,
): LandingWatchState {
  if (outcome?.status === "superseded" && state.operations.has(operationId)) {
    // As the live event does: the resubmission is the landing to show.
    const operations = new Map(state.operations);
    operations.delete(operationId);
    return { ...state, operations };
  }
  return update(state, operationId, (landing): TrackedLanding => {
    if (landing.status !== "active") return landing;
    if (outcome === undefined) return { ...landing, status: "unknown" };
    if (!outcome.terminal) return { ...landing, stage: outcome.stage };
    const status =
      outcome.status === "landed" ||
      outcome.status === "failed" ||
      outcome.status === "cancelled" ||
      outcome.status === "declined"
        ? outcome.status
        : "unknown";
    const commitId = outcome.publication?.commitId;
    const reason = outcome.failure?.reason;
    return {
      ...landing,
      status,
      stage: outcome.failure?.stage ?? outcome.stage,
      ...(commitId === undefined ? {} : { commitId }),
      ...(reason === undefined ? {} : { reason }),
    };
  });
}

/** The latest landing of `changeId` in `repo`, as a workspace's status shows it. */
export function landingForChange(
  state: LandingWatchState,
  repo: string,
  changeId: string,
): VcsStatusSlipJayLanding | undefined {
  const key = repo.toLowerCase();
  const landing = [...state.operations.values()].findLast(
    (entry) => entry.repo === key && entry.changeId === changeId,
  );
  return landing === undefined ? undefined : toStatusLanding(state, landing);
}

/** A tracked landing in `repo` by its operation id, as a workspace's status shows it. */
export function landingForOperation(
  state: LandingWatchState,
  repo: string,
  operationId: string,
): VcsStatusSlipJayLanding | undefined {
  const landing = state.operations.get(operationId);
  return landing === undefined || landing.repo !== repo.toLowerCase()
    ? undefined
    : toStatusLanding(state, landing);
}

/**
 * The landing a workspace shows for the change it would land. A change already on the
 * integration bookmark shows only the landing `submitted` from this workspace earlier:
 * a fresh workspace sits on the integration tip, which is someone else's landed change.
 * Returns the operation to remember as this workspace's submission.
 */
export function resolveWorkspaceLanding(
  state: LandingWatchState,
  repo: string,
  target: { readonly changeId: string; readonly integrated: boolean },
  submitted: string | undefined,
): {
  readonly landing: VcsStatusSlipJayLanding | undefined;
  readonly submitted: string | undefined;
} {
  if (target.integrated) {
    const landing =
      submitted === undefined ? undefined : landingForOperation(state, repo, submitted);
    return { landing, submitted: landing === undefined ? undefined : submitted };
  }
  const landing = landingForChange(state, repo, target.changeId);
  return { landing, submitted: landing?.operationId };
}

function toStatusLanding(
  state: LandingWatchState,
  landing: TrackedLanding,
): VcsStatusSlipJayLanding {
  return {
    operationId: landing.operationId,
    status: landing.status,
    stage: landing.stage,
    ...(landing.commitId === undefined ? {} : { commitId: landing.commitId }),
    ...(landing.reason === undefined ? {} : { reason: landing.reason }),
    ...(landing.spec === undefined ? {} : { spec: landing.spec }),
    live: state.connected,
  };
}

export const emptyRunnerOverview: SlipJayRunnerOverview = {
  connected: false,
  paused: false,
  serial: [],
  deploy: [],
  deploys: [],
};

/**
 * The SlipJay workspace named by a submitter label from `host`: `host:<name>` for a
 * landing, `host:<path>` for a release. Other hosts, schedules and promotions name none.
 */
export function submittingWorkspace(submittedBy: string, host: string): string | undefined {
  const separator = submittedBy.indexOf(":");
  if (separator < 0 || submittedBy.slice(0, separator) !== host) return undefined;
  const name = submittedBy
    .slice(separator + 1)
    .replace(/\/+$/, "")
    .split("/")
    .at(-1);
  return name === undefined || name.length === 0 ? undefined : name;
}

/**
 * When a running operation started work, as its first command run: the snapshot records
 * no time it left the queue. This misses the fetch and rebase before that command, but
 * stays fixed once set, where a stage's start would reset at every stage.
 */
function runStartedAt(operation: WatchOperation): string | undefined {
  if (operation.status !== "running") return undefined;
  return operation.runs?.find((run) => run.startedAt !== undefined)?.startedAt;
}

const runnerOperation = (operation: WatchOperation, host: string): SlipJayRunnerOperation => {
  const startedAt = runStartedAt(operation);
  const workspaceName =
    operation.submittedBy === undefined
      ? undefined
      : submittingWorkspace(operation.submittedBy, host);
  return {
    operationId: operation.id,
    kind: operation.kind ?? "landing",
    repo: operation.repo.toLowerCase(),
    status: operation.status ?? "queued",
    stage: operation.stage,
    submittedBy: operation.submittedBy ?? "",
    ...(operation.position === undefined ? {} : { position: operation.position }),
    ...(operation.submittedAt === undefined ? {} : { submittedAt: operation.submittedAt }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(operation.stageStartedAt === undefined ? {} : { stageStartedAt: operation.stageStartedAt }),
    ...(typeof operation.timing?.medianMs === "number"
      ? { stageMedianMs: operation.timing.medianMs }
      : {}),
    ...(operation.commitId === undefined ? {} : { commitId: operation.commitId }),
    ...(operation.environment === undefined ? {} : { environment: operation.environment }),
    ...(workspaceName === undefined ? {} : { workspaceName }),
    ...(operation.spec === undefined ? {} : { spec: operation.spec }),
  };
};

const runnerDeploy = (operation: WatchOperation): SlipJayRunnerDeploy | undefined =>
  operation.environment === undefined || operation.commitId === undefined
    ? undefined
    : {
        operationId: operation.id,
        repo: operation.repo.toLowerCase(),
        environment: operation.environment,
        commitId: operation.commitId,
        status: operation.status ?? "unknown",
        ...(operation.finishedAt === undefined ? {} : { finishedAt: operation.finishedAt }),
      };

/**
 * The runner overview a snapshot shows. Commands, environment names and outputs in the
 * snapshot stay on the server; only what the overview names reaches a client.
 */
export function runnerOverviewFromSnapshot(
  snapshot: WatchSnapshot,
  host: string,
): SlipJayRunnerOverview {
  const deploys = [
    ...watchOperations(snapshot.lastStagingDeploys),
    ...watchOperations(snapshot.recentProductionDeploys),
  ]
    .map(runnerDeploy)
    .filter((deploy) => deploy !== undefined)
    .toSorted((left, right) => (right.finishedAt ?? "").localeCompare(left.finishedAt ?? ""));
  return {
    connected: true,
    paused: snapshot.paused !== undefined && snapshot.paused !== null,
    serial: snapshot.lanes.serial.map((operation) => runnerOperation(operation, host)),
    deploy: watchOperations(snapshot.lanes.deploy).map((operation) =>
      runnerOperation(operation, host),
    ),
    deploys,
  };
}
