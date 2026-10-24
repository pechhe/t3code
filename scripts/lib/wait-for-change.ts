// @effect-diagnostics nodeBuiltinImport:off - Test fixtures watch a real directory so a wait needs no clock or poll interval.
import * as NodeFS from "node:fs";

/**
 * Runs `condition` until it holds, running it again once per change under `dir`.
 *
 * `fs.watch`'s async iterator stays dormant until its first `next()`, so a change that
 * lands between a condition read and that registration is lost when nothing follows it.
 * The callback form registers eagerly, and a change that arrives before it is awaited is
 * kept for the next pass, so the condition is always re-read after one. Closed on exit.
 */
export async function waitForChange(dir: string, condition: () => Promise<boolean>): Promise<void> {
  let changed: (() => void) | undefined;
  const watcher = NodeFS.watch(dir, () => {
    const resolve = changed;
    changed = undefined;
    resolve?.();
  });
  try {
    for (;;) {
      const nextChange = new Promise<void>((resolve) => {
        changed = resolve;
      });
      if (await condition()) return;
      await nextChange;
    }
  } finally {
    watcher.close();
  }
}
