import type { ArcRunState, ForgeStatusTone } from "@t3tools/client-runtime/state/forge-work-items";

import { cn } from "~/lib/utils";

/** The inner disc's slice from twelve o'clock, clockwise, for a part fill. */
const slice = (fill: number) => {
  const angle = fill * 2 * Math.PI;
  const x = 8 + 3.5 * Math.sin(angle);
  const y = 8 - 3.5 * Math.cos(angle);
  return `M8 8 L8 4.5 A3.5 3.5 0 ${fill > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
};

/** A ring whose disc fills with the share done; the chip's progress. Decorative. */
export function ArcRunProgressRing(props: { fill: number | null; className?: string }) {
  const fill = props.fill ?? 0;
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5 shrink-0", props.className)}>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {fill >= 1 ? (
        <circle cx="8" cy="8" r="3.5" fill="currentColor" />
      ) : fill > 0 ? (
        <path d={slice(fill)} fill="currentColor" />
      ) : null}
    </svg>
  );
}

const TONE_TEXT: Record<ForgeStatusTone, string> = {
  "not-started": "text-muted-foreground/70",
  "in-progress": "text-amber-500",
  landed: "text-emerald-500",
  accepted: "text-emerald-500",
  dropped: "text-muted-foreground/50",
  unknown: "text-muted-foreground/50",
};

/** A Spec's stage as a ring: empty until work starts, half while in progress, full with a tick once accepted. */
export function ArcSpecGlyph(props: {
  tone: ForgeStatusTone;
  shaping?: boolean;
  className?: string;
}) {
  const { tone } = props;
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={cn("size-3.5 shrink-0", TONE_TEXT[tone], props.className)}
    >
      {tone === "accepted" ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5 8.25 7.1 10.25 11 6"
            fill="none"
            className="stroke-background"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <circle
            cx="8"
            cy="8"
            r="6.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray={props.shaping ? "2.2 2.2" : undefined}
          />
          {tone === "in-progress" ? <path d={slice(0.5)} fill="currentColor" /> : null}
          {tone === "landed" ? <path d={slice(0.75)} fill="currentColor" /> : null}
        </>
      )}
    </svg>
  );
}

const STATE_DOT: Record<ArcRunState, string> = {
  running: "bg-success",
  paused: "bg-muted-foreground",
  attention: "bg-warning",
};

export function ArcRunStateDot(props: { state: ArcRunState; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[props.state], props.className)}
    />
  );
}

export const ARC_RUN_STATE_LABEL: Record<ArcRunState, string> = {
  running: "Running",
  paused: "Paused",
  attention: "Needs you",
};
