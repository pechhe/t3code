import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  collectLimitPools,
  formatDuration,
  type LimitPool,
  type LimitPoolWindow,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { observeResize } from "../../lib/observeResize";
import { environmentPresentations } from "../../state/presentation";
import { providerClients } from "../settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { barColor } from "./UsageLimits";

const CARD_WIDTH_PX = 240;
const GUTTER_MARGIN_PX = 16;

/**
 * The account-wide session and weekly windows of each provider pool. Claude also reports
 * weekly buckets for single models (`seven_day_fable`), which the corner leaves to the
 * Usage page.
 */
function cornerWindows(pool: LimitPool): LimitPoolWindow[] {
  const accountWide = pool.windows.filter(
    (window) =>
      (window.kind === "session" || window.kind === "weekly") &&
      !(pool.driver === "claudeAgent" && window.kind === "weekly" && window.id !== "seven_day"),
  );
  return (["session", "weekly"] as const).flatMap((kind) => {
    const first = accountWide.find((window) => window.kind === kind);
    return first ? [first] : [];
  });
}

function windowLabel(window: LimitPoolWindow): string {
  if (window.kind === "weekly") return "wk";
  const minutes = window.members[0]?.window.windowDurationMins;
  return minutes ? `${Math.round(minutes / 60)}h` : "session";
}

/**
 * Where the card sits in the composer overlay: in the gutter right of the centred composer,
 * level with its bottom edge, or nowhere when the gutter is too narrow to hold it.
 */
function useGutterPlacement(overlay: HTMLElement | null): number | null {
  const [bottom, setBottom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const stack = overlay?.querySelector<HTMLElement>("[data-chat-composer-stack]");
    if (!overlay || !stack) return;
    const measure = () => {
      const lane = overlay.getBoundingClientRect();
      const composer = stack.getBoundingClientRect();
      const fits = lane.right - composer.right >= CARD_WIDTH_PX + GUTTER_MARGIN_PX * 2;
      setBottom(fits ? Math.max(0, Math.round(lane.bottom - composer.bottom)) : null);
    };
    measure();
    return observeResize([overlay, stack], measure);
  }, [overlay]);
  return bottom;
}

/**
 * Subscription limits at a glance beside the composer: one row per provider window, each a
 * bar of account segments sized by plan capacity, so the filled area is what is left across
 * the pool. Hover a segment for that account.
 */
export function UsageCorner({ overlay }: { readonly overlay: HTMLElement | null }) {
  const bottom = useGutterPlacement(overlay);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  // The minute clock keeps the reset countdowns true without a render per second.
  const now = Date.parse(`${useNowMinute()}:00.000Z`);
  const navigate = useNavigate();
  if (bottom === null) return null;
  const rows = collectLimitPools(collectLimitAccounts(presentations), now).flatMap((pool) =>
    cornerWindows(pool).map((window) => ({ pool, window })),
  );
  if (rows.length === 0) return null;
  return (
    <section
      aria-label="Usage left"
      className="pointer-events-auto absolute right-4 flex flex-col gap-2 rounded-xl border border-border/70 bg-popover/95 p-3 text-xs text-popover-foreground shadow-lg backdrop-blur-sm"
      style={{ bottom, width: CARD_WIDTH_PX }}
    >
      <button
        type="button"
        className="flex items-center justify-between text-2xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
        onClick={() => void navigate({ to: "/usage" })}
      >
        <span>Usage left</span>
        <span aria-hidden>→</span>
      </button>
      {rows.map(({ pool, window }) => (
        <UsageCornerRow
          key={`${pool.driver}:${window.kind}:${window.id}`}
          pool={pool}
          window={window}
          now={now}
        />
      ))}
    </section>
  );
}

function UsageCornerRow({
  pool,
  window,
  now,
}: {
  readonly pool: LimitPool;
  readonly window: LimitPoolWindow;
  readonly now: number;
}) {
  const color = barColor(pool.driver);
  const provider = providerClients.get(pool.driver)?.label ?? String(pool.driver);
  const label = `${provider} ${windowLabel(window)}`;
  // The soonest reset that hands anything back; an untouched account resets to no effect.
  const nextRefill = window.resets.find((reset) => reset.restoresPercent > 0);
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_2.25rem] items-center gap-x-2 gap-y-0.5">
      <span className="truncate text-muted-foreground">{label}</span>
      <div
        role="img"
        aria-label={`${label}: ${window.remainingPercent}% left`}
        className="flex h-2 gap-0.5"
      >
        {window.columns.map((column) =>
          column.window ? (
            <Tooltip key={column.account.key}>
              <TooltipTrigger
                render={
                  <div
                    className="relative h-full min-w-1.5 overflow-hidden rounded-xs bg-muted"
                    style={{ flex: `${column.capacity} 1 0` }}
                  />
                }
              >
                <div
                  className="absolute inset-y-0 left-0"
                  style={{ width: `${remainingPercent(column.window)}%`, backgroundColor: color }}
                />
              </TooltipTrigger>
              <TooltipPopup>
                {[
                  column.account.displayName ?? provider,
                  column.account.plan,
                  `${remainingPercent(column.window)}% left`,
                  column.window.resetsAt
                    ? `↻ ${formatDuration(Date.parse(column.window.resetsAt) - now)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </TooltipPopup>
            </Tooltip>
          ) : null,
        )}
      </div>
      <span className="text-end font-semibold text-foreground tabular-nums">
        {window.remainingPercent}%
      </span>
      {nextRefill ? (
        <span className="col-start-2 col-end-4 text-2xs text-muted-foreground tabular-nums">
          ↻ +{nextRefill.restoresPercent}% in {formatDuration(nextRefill.at - now)}
        </span>
      ) : null}
    </div>
  );
}
