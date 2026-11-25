import { BLACKHOLE_DEFAULTS, type BlackholeConfig } from "./config.ts";
import type { SessionEntry } from "./session.ts";
import {
  observationPoolTokens,
  rawTokensSinceObservationCoverage,
} from "./upstream/om/ledger/progress.ts";
import type { Entry } from "./upstream/om/ledger/types.ts";

const GAUGE_CELLS = 8;

const gauge = (value: number, max: number): string => {
  const fraction = max > 0 ? value / max : 0;
  const filled = Math.min(GAUGE_CELLS, Math.round(Math.min(1.2, fraction) * GAUGE_CELLS));
  return `▕${"█".repeat(filled)}${"░".repeat(GAUGE_CELLS - filled)}▏`;
};

export type StatusWorker =
  | { readonly kind: "running"; readonly stage: "observer" | "reflector" | "dropper" }
  | {
      readonly kind: "done";
      readonly stage: "observer" | "reflector" | "dropper" | "compact";
      readonly added?: number;
    };

/**
 * pi-blackhole's footer status (om/status-bar.ts) in plain text: O fills toward the next observer
 * pass, P with the observation pool, X toward the compact point; then the worker. A running
 * worker shows a fixed dot, not Pi's spinner, so nothing repaints while it works.
 */
export function blackholeStatusText(input: {
  readonly entries: ReadonlyArray<SessionEntry>;
  readonly memory: boolean;
  readonly contextTokens: number;
  readonly compactPoint: number | undefined;
  readonly worker?: StatusWorker;
  readonly config?: Partial<BlackholeConfig>;
}): string {
  const config = { ...BLACKHOLE_DEFAULTS, ...input.config };
  const entries = input.entries as Entry[];
  const segments: string[] = [];
  if (input.memory) {
    segments.push(
      `O${gauge(rawTokensSinceObservationCoverage(entries), config.observeAfterTokens)}`,
    );
    segments.push(
      `P${gauge(observationPoolTokens(entries).tokens, config.observationsPoolMaxTokens)}`,
    );
  }
  segments.push(`X${gauge(input.contextTokens, input.compactPoint ?? 0)}`);
  const worker = input.worker;
  const work =
    worker === undefined
      ? ""
      : worker.kind === "running"
        ? `  • [${worker.stage}]`
        : `  ✓ [${worker.stage}]${worker.added !== undefined && worker.added > 0 ? ` +${worker.added}` : ""}`;
  return `bh ${segments.join("  ")}${work}`;
}
