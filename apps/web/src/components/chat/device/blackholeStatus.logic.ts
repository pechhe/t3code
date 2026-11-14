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
const RUNNING_WORKER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\[(observer|reflector|dropper|compact)\]/;
const DONE_WORKER_RE = /✓\s+\[(observer|reflector|dropper|compact)\](?:\s+\+(\d+))?(?:\s+(.+))?$/;

export function stripAnsi(text: string): string {
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
