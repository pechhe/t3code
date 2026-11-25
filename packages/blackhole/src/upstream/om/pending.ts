// @ts-nocheck -- vendored pi-blackhole source, type-checked upstream under its own settings.
// T3 replacement for upstream's pending.ts: only its types; T3 has no manual flush mode.
import type { OM_OBSERVATIONS_COVERAGE } from "./ledger/types.ts";
export interface PendingObservation {
  coversUpToId: string;
  data: unknown;
  /** Coverage-only empty close, flushed with this custom type. */
  customType?: typeof OM_OBSERVATIONS_COVERAGE;
}

export interface PendingReflection {
  coversUpToId: string;
  data: unknown;
}

export interface PendingDropped {
  coversUpToId: string;
  data: unknown;
}

/**
 * Coverage-inert kept facts buffered in manual mode. Unlike the other batch
 * shapes this carries no coversUpToId: the facts were recorded without any
 * head-anchored prefix, so there is no honest coverage point to store.
 */
export interface PendingUnanchored {
  data: unknown;
}

export interface PendingOMState {
  /** Latest observation run (replaced each time, not accumulated). */
  observation?: PendingObservation;
  /** Latest reflection run (replaced each time, not accumulated). */
  reflection?: PendingReflection;
  /** Latest dropper run (replaced each time, not accumulated). */
  dropped?: PendingDropped;
  /**
   * All observation batches accumulated across manual mode pipeline runs.
   * Each batch preserves per-run coverage (coversUpToId) matching the normal
   * branch-marker pattern. Used for LLM context and /blackhole flush.
   */
  observationBatches?: PendingObservation[];
  /**
   * All reflection batches accumulated across manual mode pipeline runs.
   * Preserves per-run coverage for LLM context and /blackhole flush.
   */
  reflectionBatches?: PendingReflection[];
  /**
   * All dropper batches accumulated across manual mode pipeline runs.
   * Each batch preserves which observations were dropped in that run.
   * Without accumulation, earlier drops are lost when the next dropper
   * run overwrites pending.dropped, causing them to be "un-dropped" on
   * /blackhole flush.
   */
  droppedBatches?: PendingDropped[];
  /**
   * Coverage-inert kept facts accumulated across manual mode pipeline runs:
   * observations a turn-cap cut recorded with no head-anchored prefix. Fed
   * to the pool, preamble, reflector, and dropper inputs like observation
   * batches, but never to any coverage gate or cursor — and flushed to the
   * branch under the unanchored key, not the recorded key.
   */
  unanchoredBatches?: PendingUnanchored[];
  /** Pipeline progress cursors — persist across restarts and fork recovery. */
  cursors?: {
    observer?: { entryId: string; state: string };
    reflector?: { entryId: string; state: string };
    dropper?: { entryId: string; state: string; activePoolSignature?: string };
  };
}
