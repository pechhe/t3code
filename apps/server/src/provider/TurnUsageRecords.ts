/**
 * What a provider turn tells Weave it spent (Spec #4395). A turn records either each of its own
 * provider requests, or one row for the whole turn, never a mix: a reader that saw three of a
 * turn's five requests would take a partial sum for the turn's cost.
 *
 * The turn's requests are therefore held here until the turn ends, and settled against the figure
 * T3 shows for the turn. They add up to it in the ordinary case, and are kept one by one. When they
 * do not — a request the adapter could not identify, a provider that counted something the adapter
 * never saw — the turn's own figure is the only honest one, and it replaces them.
 */
import type { ThreadId, TurnTokenUsage } from "@t3tools/contracts";

import type * as HqForgeUsage from "../hq/HqForgeUsage.ts";

/** One provider request's own share of a turn, as the provider billed it. */
export interface TurnRequestUsage {
  /** Identifies the request; null when the provider gave nothing to key it by. */
  readonly usageRef: string | null;
  readonly tokens: HqForgeUsage.HqForgeUsageTokens;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  /** Epoch milliseconds. */
  readonly endedAt: number;
  readonly modelRef: string;
}

/** The turn a buffer belongs to, and the figures that describe it as a whole. */
export interface TurnUsageIdentity {
  readonly threadId: ThreadId;
  readonly provider: string;
  readonly providerThreadId: string;
  readonly turnId: string;
  readonly modelRef: string;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  /** Epoch milliseconds. */
  readonly endedAt: number;
  readonly runId?: string;
}

/** A turn's requests, waiting for the turn to end. */
export interface TurnUsageBuffer {
  readonly requests: Array<TurnRequestUsage>;
}

export const makeTurnUsageBuffer = (): TurnUsageBuffer => ({ requests: [] });

/**
 * Adds a request. A provider repeats a report (a replayed notification, another snapshot of one
 * message), and the same ref must not count twice toward the turn's sum.
 */
export const addTurnRequestUsage = (buffer: TurnUsageBuffer, request: TurnRequestUsage): void => {
  if (
    request.usageRef !== null &&
    buffer.requests.some((seen) => seen.usageRef === request.usageRef)
  ) {
    return;
  }
  buffer.requests.push(request);
};

/** A turn's input counts cached tokens; its record keeps them separate. */
const turnTokens = (usage: TurnTokenUsage | undefined): HqForgeUsage.HqForgeUsageTokens | null => {
  if (usage === undefined) return null;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  // A turn that measured nothing has no honest figure to record, in either direction.
  if (input === undefined || output === undefined) return null;
  const cacheRead = Math.min(input, usage.cachedInputTokens ?? 0);
  const cacheWrite =
    usage.cacheCreationTokens === undefined
      ? undefined
      : Math.min(input, usage.cacheCreationTokens);
  return {
    input: Math.max(input - cacheRead - (cacheWrite ?? 0), 0),
    output,
    cacheRead,
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
};

const billedInput = (tokens: HqForgeUsage.HqForgeUsageTokens): number =>
  tokens.input + tokens.cacheRead + (tokens.cacheWrite ?? 0);

/**
 * The usage rows a finished turn owes Weave: one per request when they account for the turn's own
 * figure, and otherwise the single turn row. Unknown figures come back as a turn row with no
 * tokens, which records nothing rather than a zero.
 */
export const settleTurnUsage = (
  buffer: TurnUsageBuffer,
  turnUsage: TurnTokenUsage | undefined,
  identity: TurnUsageIdentity,
): ReadonlyArray<HqForgeUsage.HqForgeUsageInput> => {
  const tokens = turnTokens(turnUsage);
  const requests = buffer.requests;
  const everyRequestIdentified = requests.length > 0 && requests.every((r) => r.usageRef !== null);
  const requestsAccountForTurn =
    tokens !== null &&
    everyRequestIdentified &&
    requests.reduce((sum, request) => sum + billedInput(request.tokens), 0) ===
      billedInput(tokens) &&
    requests.reduce((sum, request) => sum + request.tokens.output, 0) === tokens.output;
  if (requestsAccountForTurn) {
    return requests.map((request) => ({
      threadId: identity.threadId,
      usageRef: request.usageRef!,
      tokens: request.tokens,
      startedAt: request.startedAt,
      endedAt: request.endedAt,
      modelRef: request.modelRef,
      level: "request" as const,
      ...(identity.runId === undefined ? {} : { runId: identity.runId }),
    }));
  }
  return [
    {
      threadId: identity.threadId,
      usageRef: `${identity.provider}:${identity.providerThreadId}:${identity.turnId}`,
      tokens,
      startedAt: identity.startedAt,
      endedAt: identity.endedAt,
      modelRef: identity.modelRef,
      level: "turn",
      ...(identity.runId === undefined ? {} : { runId: identity.runId }),
    },
  ];
};
