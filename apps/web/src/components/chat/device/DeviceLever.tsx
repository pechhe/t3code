import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * Shared milled vertical track and brushed-metal thumb for the device composer's
 * lever switches (the two-position machine lever and three-position stance lever).
 */
export function DeviceLeverTrack({
  trackClassName,
  thumbClassName,
  children,
}: {
  trackClassName?: string;
  thumbClassName?: string;
  children?: ReactNode;
}) {
  return (
    <span className={cn("device-lever__track", trackClassName)} aria-hidden="true">
      <span className={cn("device-lever__thumb", thumbClassName)}>{children}</span>
    </span>
  );
}
