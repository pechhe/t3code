/** A capture helper that serves one request and exits. */
export type SnapShotProcess<Request, Result> = {
  readonly alive: boolean;
  readonly capture: (request: Request) => Promise<Result>;
  readonly close: () => void;
};

export type SnapShotProcessPool<Request, Result> = {
  readonly warm: () => void;
  readonly cool: () => void;
  readonly capture: (request: Request) => Promise<Result>;
  readonly close: () => void;
};

/**
 * Keeps one single-use capture helper started ahead of the shortcut, so its
 * startup cost is paid before a capture, and starts the next after each one.
 */
export function makeSnapShotProcessPool<Request, Result>(
  start: () => SnapShotProcess<Request, Result>,
  errors: { readonly unavailable: string; readonly busy: string },
): SnapShotProcessPool<Request, Result> {
  let standby: SnapShotProcess<Request, Result> | undefined;
  let inFlight: SnapShotProcess<Request, Result> | undefined;
  let closed = false;
  const warm = () => {
    if (closed || standby?.alive) return;
    standby = start();
  };
  const cool = () => {
    standby?.close();
    standby = undefined;
  };
  return {
    warm,
    cool,
    capture: async (request) => {
      if (closed) throw new Error(errors.unavailable);
      if (inFlight?.alive) throw new Error(errors.busy);
      const current = standby?.alive ? standby : start();
      standby = undefined;
      inFlight = current;
      try {
        return await current.capture(request);
      } finally {
        if (inFlight === current) inFlight = undefined;
        warm();
      }
    },
    close: () => {
      closed = true;
      cool();
      inFlight?.close();
    },
  };
}
