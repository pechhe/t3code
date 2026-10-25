import {
  SLIPJAY_LANDING_STAGES,
  type SlipJayLandingChipTone,
} from "@t3tools/client-runtime/slipjay-checkout";
import { presentForgeWorkItem } from "@t3tools/client-runtime/state/forge-work-items";
import type { ForgeWorkItemView, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { forgeWorkItems, useThreadForgeWorkItem } from "~/state/forgeWorkItems";
import { useEnvironmentQuery } from "~/state/query";
import { ForgeItemLabel } from "./forgeItem/ForgeItemLabel";

/*
 * SlipJay's identity: every landing is a ticket. Its stub carries the state (paper while
 * waiting, jay blue while running, red when it failed, mint once landed, when it also
 * tears off), the perforation dots are the runner's stages, and the jay is the mark.
 * The colours are SlipJay's own on every T3 theme; the paper follows the theme's surfaces.
 */

const JAY_PATH =
  "M9 43C9 31 13 23 19 19L12 9l10 5-2-8 8 8c6 0 11 4 12 9l7 3-7 2c-1 7-7 12-15 13l-4 2z";

/** The jay. Its body is `currentColor`; `--jay-beak` and `--jay-eye` colour the rest. */
export function SlipJayMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      aria-hidden
      data-slot="jay"
      className={cn("size-3.5 shrink-0", className)}
    >
      <path d={JAY_PATH} fill="currentColor" />
      <path d="M39.5 22.5L47 25.5 39.5 28z" fill="var(--jay-beak, #0b0c0f)" />
      <circle cx="32" cy="21.5" r="2.6" fill="var(--jay-eye, #2b6ce0)" />
    </svg>
  );
}

export type SlipJayTicketTone = SlipJayLandingChipTone;

const STUB_TONE: Record<SlipJayTicketTone, string> = {
  waiting: "bg-muted text-foreground [--jay-beak:var(--color-slipjay)] [--jay-eye:var(--muted)]",
  running: "bg-slipjay text-white [--jay-eye:var(--color-slipjay)]",
  failed: "bg-slipjay-failed text-white [--jay-eye:var(--color-slipjay-failed)]",
  landed:
    "bg-slipjay-mint text-slipjay-mint-foreground [--jay-eye:var(--color-slipjay-mint)] *:data-[slot=jay]:text-slipjay",
  ended: "bg-muted text-muted-foreground [--jay-beak:currentColor] [--jay-eye:var(--muted)]",
};

const TEETH = 10;
const tornEdge = (side: "stub" | "body") => {
  const points =
    side === "stub"
      ? [
          "0 0",
          ...Array.from(
            { length: TEETH + 1 },
            (_, index) =>
              `calc(100% - ${index % 2 === 0 ? 4 : 0}px) ${((index * 100) / TEETH).toFixed(1)}%`,
          ),
          "0 100%",
        ]
      : [
          "100% 0",
          "100% 100%",
          ...Array.from({ length: TEETH + 1 }, (_, index) => {
            const step = TEETH - index;
            return `${step % 2 === 0 ? 0 : 4}px ${((step * 100) / TEETH).toFixed(1)}%`;
          }),
        ];
  return { clipPath: `polygon(${points.join(",")})` } satisfies CSSProperties;
};
const STUB_TORN = tornEdge("stub");
const BODY_TORN = tornEdge("body");

/**
 * A SlipJay ticket: a stub, a dashed perforation and a body, with notches masked out so
 * any surface shows through. A landed ticket tears along the perforation; `torn` moves
 * the stub, and the move animates only when it changes. A `solid` ticket is one colour
 * throughout, a tag for toolbars where a paper body would read as a second control.
 */
export function SlipJayTicket({
  tone,
  stub,
  torn = false,
  solid = false,
  className,
  children,
}: {
  tone: SlipJayTicketTone;
  stub: ReactNode;
  torn?: boolean;
  solid?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ripped = tone === "landed";
  if (solid) {
    return (
      <div className={cn("flex min-w-0 items-stretch rounded-md", STUB_TONE[tone], className)}>
        <div className="relative flex shrink-0 items-center px-2 after:absolute after:inset-y-1.5 after:end-0 after:border-e-2 after:border-dotted after:border-current/35">
          {stub}
        </div>
        <div className="flex min-w-0 items-center">{children}</div>
      </div>
    );
  }
  return (
    <div className={cn("flex min-w-0 items-stretch drop-shadow-xs", className)}>
      <div
        className={cn(
          "relative flex shrink-0 items-center gap-1 rounded-s-md px-2 font-mono font-semibold text-2xs transition-transform duration-350 ease-slipjay-tear motion-reduce:transition-none",
          !ripped &&
            "[mask-image:radial-gradient(circle_at_100%_50%,transparent_3.2px,black_3.6px)] after:absolute after:inset-y-1 after:-end-px after:border-e-2 after:border-dotted after:border-border",
          ripped && "pe-3",
          torn && "origin-bottom-right translate-x-[-3px] translate-y-px -rotate-4",
          STUB_TONE[tone],
        )}
        style={ripped ? STUB_TORN : undefined}
      >
        {stub}
      </div>
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-e-md bg-card text-foreground",
          ripped
            ? "ps-3"
            : "ps-2.5 [mask-image:radial-gradient(circle_at_0_50%,transparent_3.2px,black_3.6px)]",
        )}
        style={ripped ? BODY_TORN : undefined}
      >
        {children}
      </div>
    </div>
  );
}

/** The landing's stages as perforation dots: finished ones filled, the current one lit. */
export function SlipJayStageDots({
  tone,
  completed,
  current,
}: {
  tone: SlipJayTicketTone;
  completed: number;
  current: number | null;
}) {
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-0.5">
      {SLIPJAY_LANDING_STAGES.map((stage, index) => (
        <span
          key={stage}
          className={cn(
            "size-1.5 rounded-full",
            index < completed
              ? tone === "landed"
                ? "bg-slipjay-mint"
                : "bg-slipjay"
              : index === current
                ? tone === "failed"
                  ? "bg-slipjay-failed"
                  : "bg-slipjay-light"
                : "bg-foreground/12 inset-shadow-xs",
          )}
        />
      ))}
    </span>
  );
}

export interface SlipJaySpec {
  number: number;
  ref: string | null;
  title: string | null;
  status: string | null;
  held: boolean;
  /** The item's page in HQ; null until Forge answers for it. */
  url: string | null;
}

const specFromView = (view: ForgeWorkItemView): SlipJaySpec => {
  const shown = presentForgeWorkItem(view);
  return {
    number: view.number,
    ref: view.item?.ref ?? null,
    title: view.item === null ? null : shown.title,
    status: shown.statusLabel,
    held: shown.held,
    url: view.url,
  };
};

/**
 * The HQ Forge Spec a landing delivers. `number` is the one SlipJay recorded for the landing;
 * without it, the submitting thread's own linked Spec. A number Forge does not answer for is
 * still shown, by number.
 */
export function useSlipJaySpec(
  threadRef: ScopedThreadRef | null,
  number?: number,
  /** The thread Forge is read through when `threadRef` has none, such as the one on screen. */
  lookupRef: ScopedThreadRef | null = threadRef,
): SlipJaySpec | null {
  const link = useThreadForgeWorkItem(threadRef).data;
  const linked =
    link != null &&
    (link.item === null || link.item.kind === "spec") &&
    (number === undefined || link.number === number)
      ? link
      : null;
  const mentioned = useEnvironmentQuery(
    linked === null && number !== undefined && lookupRef !== null
      ? forgeWorkItems.mentions({
          environmentId: lookupRef.environmentId,
          input: { threadId: lookupRef.threadId, numbers: [number] },
        })
      : null,
  ).data?.items.find((item) => item.number === number);
  const view = linked ?? mentioned;
  if (view !== undefined) return specFromView(view);
  return number === undefined
    ? null
    : { number, ref: null, title: null, status: null, held: false, url: null };
}

/** A Spec's ref, opening its page in HQ once Forge has given one. */
export function SlipJaySpecLink({ spec, className }: { spec: SlipJaySpec; className?: string }) {
  if (spec.url === null)
    return <ForgeItemLabel item={spec} {...(className === undefined ? {} : { className })} />;
  return (
    <a
      href={spec.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "rounded-sm underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
    >
      <ForgeItemLabel item={spec} />
    </a>
  );
}

/** The current time, re-read every second only while `ticking`. */
export function useNow(ticking: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const tick = () => setNow(Date.now());
    // The time read at mount may be long past by the time ticking starts.
    const first = window.setTimeout(tick, 0);
    const interval = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [ticking]);
  return now;
}
