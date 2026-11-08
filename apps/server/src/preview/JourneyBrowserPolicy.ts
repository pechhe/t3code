import type { ChampionJourneyStep, PreviewTaskResult, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** The thread's browser while a Champion check owns it; never from what a caller says. */
export interface JourneyGrant {
  readonly checkId: string;
  /** `host:port` entries the browser may reach, and nothing else, public addresses included. */
  readonly allow: ReadonlyArray<string>;
  readonly tabLimit: number;
  /** A journey's own decisions; a replay is judged by its agent and spends none. */
  readonly decisionCap: number;
  readonly journeyLimit: number;
}

export interface JourneyNetworkDecision {
  readonly host: string;
  readonly port: number;
  readonly allowed: boolean;
}

/** The argument that finds a check's Chrome processes in `/proc`, which is how its priority is read back. */
export const journeyBrowserMarker = (checkId: string) => `--t3-journey-check=${checkId}`;

/**
 * How browser code learns a thread belongs to a journey check. The browser and task services run
 * below the Champions service in the layer graph, so they depend on this and not on it.
 */
export class JourneyBrowserPolicy extends Context.Service<
  JourneyBrowserPolicy,
  {
    /** undefined for an ordinary thread. A journey Champion's thread with no target up gets an empty allowance. */
    readonly forThread: (threadId: ThreadId) => Effect.Effect<JourneyGrant | undefined>;
    /** Buffered and persisted shortly after; must not slow a proxied request. */
    readonly record: (checkId: string, decision: JourneyNetworkDecision) => void;
    /** Decisions this tab's journey may still spend, or a refusal when the check is out of journeys. */
    readonly admitTask: (input: {
      readonly grant: JourneyGrant;
      readonly tabId: string;
    }) => Effect.Effect<
      | { readonly _tag: "admitted"; readonly decisions: number }
      | { readonly _tag: "refused"; readonly message: string }
    >;
    readonly recordTask: (input: {
      readonly grant: JourneyGrant;
      readonly tabId: string;
      readonly goal: string | null;
      readonly startedAt: string;
      readonly endedAt: string;
      readonly result: PreviewTaskResult;
      readonly steps: ReadonlyArray<ChampionJourneyStep>;
    }) => Effect.Effect<void>;
  }
>()("t3/preview/JourneyBrowserPolicy") {}
