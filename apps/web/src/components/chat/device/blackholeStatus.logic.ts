import { blackholeCompactPoint } from "@t3tools/shared/blackholeCompactPoint";

export type BlackholeWorkerPhase = "observer" | "reflector" | "dropper" | "compact";

export type BlackholeWorkerState =
  | { readonly kind: "running"; readonly phase: BlackholeWorkerPhase }
  | {
      readonly kind: "done";
      readonly phase: BlackholeWorkerPhase;
      readonly delta: number | null;
      readonly note: string | null;
    };

export interface BlackholeStatusSnapshot {
  readonly memoryEnabled: boolean;
  readonly observerFraction: number | null;
  readonly poolFraction: number | null;
  readonly compactionFraction: number | null;
  readonly worker: BlackholeWorkerState | null;
}

const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*m/g;
const GAUGE_RE = /\b([OPX])▕([█░]+)▏/g;
const RUNNING_WORKER_RE = /[•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\[(observer|reflector|dropper|compact)\]/;
const DONE_WORKER_RE = /✓\s+\[(observer|reflector|dropper|compact)\](?:\s+\+(\d+))?(?:\s+(.+))?$/;

export interface ThreadCompactionSavings {
  readonly compactionCount: number;
  readonly freedTokens: number;
}

export function resolveThreadCompactionSavings(
  projection:
    | {
        readonly compactionSummary?: ThreadCompactionSavings | undefined;
        readonly turnItems: ReadonlyArray<{
          readonly type: string;
          readonly status?: string | undefined;
          readonly beforeTokenCount?: number | null | undefined;
          readonly afterTokenCount?: number | null | undefined;
        }>;
      }
    | null
    | undefined,
): ThreadCompactionSavings {
  if (!projection) return { compactionCount: 0, freedTokens: 0 };
  if (projection.compactionSummary !== undefined) {
    return projection.compactionSummary;
  }
  return summarizeThreadCompactionSavings(projection.turnItems);
}

export function summarizeThreadCompactionSavings(
  items: ReadonlyArray<{
    readonly type: string;
    readonly status?: string | undefined;
    readonly beforeTokenCount?: number | null | undefined;
    readonly afterTokenCount?: number | null | undefined;
  }>,
): ThreadCompactionSavings {
  let compactionCount = 0;
  let freedTokens = 0;
  for (const item of items) {
    if (item.type !== "compaction" || item.status !== "completed") continue;
    if (typeof item.beforeTokenCount !== "number" || typeof item.afterTokenCount !== "number") {
      continue;
    }
    compactionCount += 1;
    freedTokens += Math.max(0, item.beforeTokenCount - item.afterTokenCount);
  }
  return { compactionCount, freedTokens };
}

/**
 * Pi Blackhole is installed where its Pi instance lists the extension's `/blackhole` command;
 * every other harness has it when T3 compacts its threads with Blackhole (the server's
 * `blackhole.compaction`). Either way the glyph stays while no session reports a status.
 */
export function providerHasBlackhole(
  driver: string | null | undefined,
  slashCommands: ReadonlyArray<{ readonly name: string }>,
  serverBlackhole: boolean,
): boolean {
  if (driver === "pi") return slashCommands.some((command) => command.name === "blackhole");
  return serverBlackhole && driver !== null && driver !== undefined;
}

/**
 * Where a thread compacts, for the context bar's line: on a harness T3 compacts with Blackhole the
 * harness reports its own backstop, so the line shows Blackhole's point instead.
 */
export function blackholeCompactLineThreshold(input: {
  readonly driver: string | null | undefined;
  readonly serverBlackhole: boolean;
  readonly compactAt: number | null;
  readonly windowTokens: number | null | undefined;
  readonly reported: number | null | undefined;
}): number | null | undefined {
  if (input.driver === "pi" || !providerHasBlackhole(input.driver, [], input.serverBlackhole))
    return input.reported;
  return (
    blackholeCompactPoint({ compactAt: input.compactAt, windowTokens: input.windowTokens }) ??
    input.reported
  );
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function parseGaugeFraction(cells: string): number {
  if (cells.length === 0) return 0;
  let filled = 0;
  for (const ch of cells) {
    if (ch === "█") filled += 1;
  }
  return filled / cells.length;
}

/**
 * Parse pi-blackhole's `setStatus("blackhole", ...)` footer text into structured
 * gauges and worker state for the context bar. Returns null when no blackhole
 * status is present or the text is not a recognized blackhole status string.
 */
export function parseBlackholeExtensionStatus(
  statuses: ReadonlyArray<{ readonly key: string; readonly text: string }> | undefined,
): BlackholeStatusSnapshot | null {
  const entry = statuses?.find((status) => status.key === "blackhole");
  if (!entry) return null;
  const plain = stripAnsi(entry.text).trim();
  if (!plain.startsWith("bh ")) return null;

  let observerFraction: number | null = null;
  let poolFraction: number | null = null;
  let compactionFraction: number | null = null;
  for (const match of plain.matchAll(GAUGE_RE)) {
    const label = match[1];
    const cells = match[2];
    if (!label || !cells) continue;
    const fraction = parseGaugeFraction(cells);
    if (label === "O") observerFraction = fraction;
    else if (label === "P") poolFraction = fraction;
    else if (label === "X") compactionFraction = fraction;
  }

  let worker: BlackholeWorkerState | null = null;
  const running = plain.match(RUNNING_WORKER_RE);
  if (running?.[1]) {
    worker = { kind: "running", phase: running[1] as BlackholeWorkerPhase };
  } else {
    const done = plain.match(DONE_WORKER_RE);
    if (done?.[1]) {
      const delta = done[2] ? Number.parseInt(done[2], 10) : null;
      const note = done[3]?.trim() || null;
      worker = {
        kind: "done",
        phase: done[1] as BlackholeWorkerPhase,
        delta: delta !== null && Number.isFinite(delta) ? delta : null,
        note,
      };
    }
  }

  return {
    memoryEnabled: observerFraction !== null || poolFraction !== null,
    observerFraction,
    poolFraction,
    compactionFraction,
    worker,
  };
}
