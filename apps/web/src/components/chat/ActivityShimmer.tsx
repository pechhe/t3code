import type { ReactNode } from "react";

/**
 * The shimmer sweep over a live activity label. Render it inside a relatively
 * positioned, overflow-hidden span that also holds the plain label, and attach
 * `observeVisibleAnimation` to that span so the sweep pauses off-screen.
 */
export function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}
