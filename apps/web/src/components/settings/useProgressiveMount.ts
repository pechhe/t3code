import { startTransition, useEffect, useMemo, useState } from "react";

/**
 * The entries of `wanted` mounted so far. One more mounts each frame, so a
 * broad list never blocks typing with a single large commit; entries already
 * mounted stay, keeping their state while `wanted` narrows or widens.
 */
export function useProgressiveMount<T>(wanted: readonly T[]): readonly T[] {
  const [mounted, setMounted] = useState<ReadonlySet<T>>(new Set());
  const next = wanted.find((entry) => !mounted.has(entry));
  useEffect(() => {
    if (next === undefined) return;
    const frame = requestAnimationFrame(() =>
      startTransition(() => setMounted((current) => new Set(current).add(next))),
    );
    return () => cancelAnimationFrame(frame);
  }, [next]);
  return useMemo(() => wanted.filter((entry) => mounted.has(entry)), [mounted, wanted]);
}
