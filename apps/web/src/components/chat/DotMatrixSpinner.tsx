import type { CSSProperties } from "react";

import { observeVisibleAnimation } from "../../lib/visibleAnimation";

const GRID = 5;
const DOTS = Array.from({ length: GRID * GRID }, (_, index) => {
  const row = Math.floor(index / GRID);
  const col = index % GRID;
  // Distance along the top-right to bottom-left diagonal, normalised to 0..1,
  // with alternate diagonals half a cycle apart ("Neon Drift").
  const path = (row + (GRID - 1 - col)) / ((GRID - 1) * 2);
  const parity = (row + (GRID - 1 - col)) % 2;
  return { index, delay: path * 0.2 + parity * 0.5 };
});

/**
 * A 5×5 dot-matrix loader ported from Peach Pi's "Neon Drift". Each dot is an
 * opacity-only CSS animation, so it stays on the compositor; it pauses off
 * screen and holds a still frame under reduced motion.
 */
export function DotMatrixSpinner({ size = 14, dotSize = 2 }: { size?: number; dotSize?: number }) {
  const gap = Math.max(1, Math.floor((size - dotSize * GRID) / (GRID - 1)));
  return (
    <span
      ref={observeVisibleAnimation}
      aria-hidden
      className="inline-grid shrink-0"
      style={{
        gridTemplateColumns: `repeat(${GRID}, ${dotSize}px)`,
        gap,
      }}
    >
      {DOTS.map((dot) => (
        <span
          key={dot.index}
          className="dot-matrix-dot block rounded-full bg-current"
          style={{ width: dotSize, height: dotSize, "--dot-delay": dot.delay } as CSSProperties}
        />
      ))}
    </span>
  );
}
