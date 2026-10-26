// @effect-diagnostics globalTimers:off - Display timing for the Away key, outside an Effect runtime.

/**
 * Away across every connected environment the person can change: on, off, or mixed when they
 * disagree (one was offline when it was pressed, say). Pressing the key turns Away off only when
 * it is on everywhere; otherwise it turns it on everywhere.
 */
export function summarizeAway(environments: ReadonlyArray<boolean>) {
  const on = environments.filter(Boolean).length;
  const total = environments.length;
  const state = total === 0 || on === 0 ? "off" : on === total ? "on" : "mixed";
  return { state, on, total, next: state !== "on" } as const;
}

type AwayState = ReturnType<typeof summarizeAway>["state"];

/** What the key shows: the press not yet confirmed, if any, else the servers' state. */
export function shownAway(server: ReturnType<typeof summarizeAway>, pending: boolean | null) {
  return pending === null
    ? server
    : { ...server, state: pending ? ("on" as const) : ("off" as const), next: !pending };
}

/** How long a confirmed press outlasts servers that still report otherwise. */
export const AWAY_PRESS_GRACE_MS = 1500;

/**
 * The Away key's presses. Each shows at once (`changed`) and is held until the servers report it,
 * or for `AWAY_PRESS_GRACE_MS` after its calls return, whichever is first. Presses made while a
 * call is in flight collapse into one call for the last of them, so a fast on-off-on lands as on.
 */
export function createAwayPress<E>(options: {
  readonly set: (environment: E, away: boolean) => Promise<{ readonly _tag: string }>;
  readonly changed: (pending: boolean | null) => void;
  readonly failed: (environments: ReadonlyArray<E>) => void;
}) {
  let pending: boolean | null = null;
  let queued: { readonly away: boolean; readonly environments: ReadonlyArray<E> } | null = null;
  let running = false;
  let server: AwayState = "off";
  let grace: ReturnType<typeof setTimeout> | undefined;
  const reported = () => pending !== null && server === (pending ? "on" : "off");
  const release = () => {
    clearTimeout(grace);
    grace = undefined;
    pending = null;
    options.changed(null);
  };
  const run = async () => {
    running = true;
    const failed = new Set<E>();
    try {
      while (queued !== null) {
        const { away, environments: targets } = queued;
        queued = null;
        const results = await Promise.allSettled(
          targets.map((target) => options.set(target, away)),
        );
        results.forEach((result, index) => {
          if (result.status === "rejected" || result.value._tag === "Failure") {
            failed.add(targets[index]!);
          }
        });
      }
    } finally {
      running = false;
    }
    if (failed.size > 0) {
      release();
      options.failed([...failed]);
    } else if (reported()) release();
    else if (pending !== null) grace = setTimeout(release, AWAY_PRESS_GRACE_MS);
  };
  return {
    /** Set Away on these environments, the ones the key covers as it is pressed. */
    press(away: boolean, environments: ReadonlyArray<E>) {
      clearTimeout(grace);
      grace = undefined;
      pending = away;
      queued = { away, environments };
      options.changed(away);
      if (!running) void run();
    },
    /** Tell it what the servers report, so a confirmed press can give way to them. */
    observe(state: AwayState) {
      server = state;
      if (!running && reported()) release();
    },
  };
}
