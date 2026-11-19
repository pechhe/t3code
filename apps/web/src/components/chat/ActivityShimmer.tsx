import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * The shimmer sweep over a live activity label. Render it inside a relatively
 * positioned, overflow-hidden span that also holds the plain label, and attach
 * `observeVisibleAnimation` to that span so the sweep pauses off-screen.
 */
export function ActivityShimmerOverlay({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className={cn("live-activity-focus-aligned block text-foreground", className)}>
          {children}
        </span>
      </span>
    </span>
  );
}
