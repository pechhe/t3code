import {
  RUN_SETUP_ROUTING_MAX_CANDIDATES,
  type RunSetupRouting,
  type RunSetupRoutingCandidate,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import {
  accountIdOf,
  rankingResetMs,
  usageReadingOf,
  type AccountAvailability,
} from "@t3tools/shared/accountPools";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** An account and model a decision weighed, with the state it was read in. */
export interface RoutedCandidate {
  readonly provider: ServerProvider;
  readonly model: string;
  readonly availability: AccountAvailability;
}

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** One candidate as the decision saw it; only T3's own account ids and usage figures, no secrets. */
const routingCandidate = (
  candidate: RoutedCandidate,
  nowMs: number,
  chosen: boolean,
): RunSetupRoutingCandidate => {
  const { provider, model, availability } = candidate;
  const reading = usageReadingOf({ provider, model }, nowMs);
  const rankingReset = rankingResetMs({ provider, model }, nowMs);
  const { block } = availability;
  const heldBackReason: RunSetupRoutingCandidate["heldBackReason"] =
    availability.state === "available"
      ? chosen
        ? undefined
        : "not-preferred"
      : availability.state === "reserved"
        ? "reserved"
        : availability.state === "cooldown"
          ? "cooldown"
          : block !== undefined && (availability.remainingPercent ?? 1) > 0
            ? "blocked"
            : "exhausted";
  const checkedMs = reading === undefined ? Number.NaN : Date.parse(reading.checkedAt);
  const tightest = reading?.tightest;
  return {
    model,
    instanceId: provider.instanceId,
    account: accountIdOf(provider, model),
    eligible: availability.state === "available",
    ...(heldBackReason === undefined ? {} : { heldBackReason }),
    ...(availability.remainingPercent === undefined
      ? {}
      : { remainingPercent: availability.remainingPercent }),
    ...(tightest === undefined
      ? {}
      : {
          windowId: tightest.id,
          windowKind: tightest.kind,
          ...(tightest.resetsAt === undefined ? {} : { resetsAt: tightest.resetsAt }),
        }),
    ...(rankingReset === undefined ? {} : { rankingResetsAt: isoOf(rankingReset) }),
    ...(reading === undefined || !Number.isFinite(checkedMs)
      ? {}
      : {
          readingCheckedAt: reading.checkedAt,
          readingAgeSeconds: Math.max(0, Math.round((nowMs - checkedMs) / 1000)),
        }),
    ...(block === undefined
      ? {}
      : {
          block: {
            reason: block.reason,
            since: block.since,
            until: block.until,
            reportedReset: block.reportedReset,
            attempts: block.attempts,
          },
        }),
  };
};

/**
 * The decision as the run's setup record keeps it. `ranked` is every candidate in the order the
 * decision tried them, the chosen one included; the list is capped, always keeping the chosen one.
 */
export const routingSnapshot = (input: {
  readonly kind: "role-candidates" | "account-pool";
  readonly nowMs: number;
  readonly role?: string | undefined;
  readonly pinned: boolean;
  readonly modelNamed: boolean;
  readonly chosen: RoutedCandidate;
  readonly ranked: ReadonlyArray<RoutedCandidate>;
}): RunSetupRouting => {
  const all = input.ranked.map((candidate) =>
    routingCandidate(candidate, input.nowMs, candidate === input.chosen),
  );
  const chosenIndex = input.ranked.indexOf(input.chosen);
  const cap = RUN_SETUP_ROUTING_MAX_CANDIDATES;
  const candidates =
    all.length <= cap
      ? all
      : chosenIndex < cap
        ? all.slice(0, cap)
        : [...all.slice(0, cap - 1), all[chosenIndex]!];
  return {
    decidedAt: isoOf(input.nowMs),
    kind: input.kind,
    ...(input.role === undefined ? {} : { role: input.role }),
    pinned: input.pinned,
    modelNamed: input.modelNamed,
    chosen: {
      model: input.chosen.model,
      instanceId: input.chosen.provider.instanceId,
      account: accountIdOf(input.chosen.provider, input.chosen.model),
    },
    candidates,
    ...(all.length > candidates.length ? { truncated: true } : {}),
  };
};

/** How far a decision may precede its run's start and still be that run's. */
const DECISION_MAX_AGE_MS = 2 * 60 * 1000;
const CLOCK_SKEW_MS = 1000;

const sameTurn = (earlier: string, later: string) =>
  Math.abs(Date.parse(later) - Date.parse(earlier)) <= DECISION_MAX_AGE_MS;

/**
 * The decision, when it can be the one behind a run that started at `startedAt` (ISO) with
 * `selection`: the same instance and model, made shortly before the start.
 */
export const decisionForRun = (
  decision: RunSetupRouting | undefined,
  run: { readonly modelSelection: { readonly instanceId: string; readonly model: string } },
  startedAt: string,
): RunSetupRouting | undefined => {
  if (decision === undefined) return undefined;
  const gap = Date.parse(startedAt) - Date.parse(decision.decidedAt);
  return decision.chosen.instanceId === run.modelSelection.instanceId &&
    decision.chosen.model === run.modelSelection.model &&
    gap >= -CLOCK_SKEW_MS &&
    gap <= DECISION_MAX_AGE_MS
    ? decision
    : undefined;
};

/** A role's choice and the pool placement that followed it are one decision with both parts. */
export const mergeRouting = (earlier: RunSetupRouting, later: RunSetupRouting): RunSetupRouting => {
  // Decisions made far apart belong to different turns.
  if (earlier.kind === later.kind || !sameTurn(earlier.decidedAt, later.decidedAt)) return later;
  // The later decision's candidates come first: its chosen one is among them and survives the cap.
  const candidates = [...later.candidates, ...earlier.candidates];
  return {
    ...later,
    kind: "both",
    ...(earlier.role === undefined && later.role === undefined
      ? {}
      : { role: earlier.role ?? later.role }),
    pinned: earlier.pinned || later.pinned,
    modelNamed: earlier.modelNamed || later.modelNamed,
    candidates: candidates.slice(0, RUN_SETUP_ROUTING_MAX_CANDIDATES),
    ...(candidates.length > RUN_SETUP_ROUTING_MAX_CANDIDATES ||
    earlier.truncated === true ||
    later.truncated === true
      ? { truncated: true }
      : {}),
  };
};

const MAX_PENDING = 256;

/**
 * Routing decisions waiting for their run. A decision is made before its run exists, so it is
 * held by thread until the run's setup is captured, which takes it. In memory: a restart between
 * the decision and the run's start loses it, and the record then simply has no `routing`.
 */
export class RoutingDecisions extends Context.Service<
  RoutingDecisions,
  {
    readonly note: (threadId: ThreadId, routing: RunSetupRouting) => Effect.Effect<void>;
    readonly take: (threadId: ThreadId) => Effect.Effect<RunSetupRouting | undefined>;
  }
>()("t3/agents/RoutingDecisions") {}

export const layer = Layer.sync(RoutingDecisions, () => {
  const pending = new Map<string, RunSetupRouting>();
  return RoutingDecisions.of({
    note: Effect.fn("RoutingDecisions.note")(function* (threadId, routing) {
      yield* Effect.sync(() => {
        const earlier = pending.get(threadId);
        pending.delete(threadId);
        pending.set(threadId, earlier === undefined ? routing : mergeRouting(earlier, routing));
        if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!);
      });
    }),
    take: Effect.fn("RoutingDecisions.take")(function* (threadId) {
      return yield* Effect.sync(() => {
        const routing = pending.get(threadId);
        pending.delete(threadId);
        return routing;
      });
    }),
  });
});
