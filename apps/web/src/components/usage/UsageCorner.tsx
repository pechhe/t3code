import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  collectLimitPools,
  formatDuration,
  type LimitAccount,
  type LimitPool,
  type LimitPoolWindow,
  planCapacity,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, type ReactNode, useLayoutEffect, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { observeResize } from "../../lib/observeResize";
import { environmentPresentations } from "../../state/presentation";
import { providerClients } from "../settings/providerDriverMeta";
import { ArrowRightIcon } from "lucide-react";

import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_CARD_GAP,
  THREAD_DETAILS_CARD_WIDTH,
} from "../chat/threadDetailsCardLayout";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { useChatCanvas } from "../chat/ChatCanvasContext";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { barColor } from "./UsageLimits";

// Same width and edge as the thread details card above it, so the two read as one column.
const CARD_WIDTH_PX = THREAD_DETAILS_CARD_WIDTH;
const GUTTER_MARGIN_PX = THREAD_DETAILS_CARD_GAP;

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

/**
 * A short name telling accounts apart: the instance's display name, else its instance id
 * (`claude_ys` → `ys`). Emails stay off the card, as on the Usage page.
 */
function accountName(account: LimitAccount): string {
  if (account.displayName) return account.displayName;
  const id = account.key.slice(account.key.indexOf(":") + 1).replace(/\.json$/i, "");
  return id.replace(/^(claude|codex)[_-]/i, "") || id;
}

function windowLabel(window: LimitPoolWindow): string {
  if (window.kind === "weekly") return "wk";
  const minutes = window.members[0]?.window.windowDurationMins;
  return minutes ? `${Math.round(minutes / 60)}h` : "session";
}

/**
 * Where the column sits in the composer overlay: in the gutter right of the centred composer,
 * level with its bottom edge, or nowhere when the gutter is too narrow to hold it. `top` is
 * the column's bottom edge measured from the chat canvas top, which bounds how tall it grows.
 */
function useGutterPlacement(
  overlay: HTMLElement | null,
): { readonly bottom: number; readonly top: number } | null {
  const [placement, setPlacement] = useState<{ bottom: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const stack = overlay?.querySelector<HTMLElement>("[data-chat-composer-stack]");
    if (!overlay || !stack) return;
    const canvas = overlay.closest<HTMLElement>("[data-chat-canvas]");
    const measure = () => {
      const lane = overlay.getBoundingClientRect();
      const composer = stack.getBoundingClientRect();
      const fits = lane.right - composer.right >= CARD_WIDTH_PX + GUTTER_MARGIN_PX * 2;
      const bottom = Math.max(0, Math.round(lane.bottom - composer.bottom));
      const top = Math.round(lane.bottom - bottom - (canvas?.getBoundingClientRect().top ?? 0));
      setPlacement((current) =>
        !fits
          ? null
          : current?.bottom === bottom && current.top === top
            ? current
            : { bottom, top },
      );
    };
    measure();
    return observeResize(canvas ? [overlay, stack, canvas] : [overlay, stack], measure);
  }, [overlay]);
  return placement;
}

/**
 * Subscription limits at a glance beside the composer: one row per provider window, each a
 * bar of account segments sized by plan capacity, so the filled area is what is left across
 * the pool. Hover a segment for that account.
 */
export function UsageCorner({
  overlay,
  above,
}: {
  readonly overlay: HTMLElement | null;
  /** A card stacked above usage in the same column, such as the side chat. */
  readonly above?: ReactNode;
}) {
  const placement = useGutterPlacement(overlay);
  const canvas = useChatCanvas();
  // Below the inline details card, else below the find bar when it is open.
  const columnTop = canvas?.detailsCardBottom ?? canvas?.detailsCardTopInset ?? 0;
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  // The minute clock keeps the reset countdowns true without a render per second.
  const now = Date.parse(`${useNowMinute()}:00.000Z`);
  const navigate = useNavigate();
  if (placement === null) return null;
  const rows = collectLimitPools(collectLimitAccounts(presentations), now).flatMap((pool) =>
    cornerWindows(pool).map((window) => ({ pool, window })),
  );
  if (rows.length === 0 && !above) return null;
  const maxHeight = Math.max(0, placement.top - columnTop - GUTTER_MARGIN_PX);
  return (
    <div
      className="pointer-events-none absolute flex flex-col justify-end gap-2"
      style={{
        bottom: placement.bottom,
        right: GUTTER_MARGIN_PX,
        width: CARD_WIDTH_PX,
        height: maxHeight,
      }}
    >
      {above}
      {rows.length === 0 ? null : (
        <UsageCard rows={rows} now={now} onOpenUsage={() => void navigate({ to: "/usage" })} />
      )}
    </div>
  );
}

function UsageCard({
  rows,
  now,
  onOpenUsage,
}: {
  readonly rows: ReadonlyArray<{ readonly pool: LimitPool; readonly window: LimitPoolWindow }>;
  readonly now: number;
  readonly onOpenUsage: () => void;
}) {
  return (
    <div className="dropdown-glass pointer-events-auto flex-none overflow-hidden rounded-3xl text-xs">
      <ThreadDetailsSection
        headingId="usage-corner-heading"
        title="Usage left"
        separated={false}
        actions={
          <ThreadDetailsControl part="icon" aria-label="Open Usage" onClick={onOpenUsage}>
            <ArrowRightIcon className="size-3.5 text-muted-foreground" />
          </ThreadDetailsControl>
        }
      >
        <div className="flex flex-col gap-2 px-1.5">
          {rows.map(({ pool, window }, index) => (
            <Fragment key={`${pool.driver}:${window.kind}:${window.id}`}>
              <UsageCornerRow pool={pool} window={window} now={now} />
              {pool.accounts.length > 1 && rows[index + 1]?.pool !== pool ? (
                <PoolLegend pool={pool} />
              ) : null}
            </Fragment>
          ))}
        </div>
      </ThreadDetailsSection>
    </div>
  );
}

/** The pool's accounts in segment order, each with the plan multiplier its segment is sized by. */
function PoolLegend({ pool }: { readonly pool: LimitPool }) {
  return (
    <div className="flex flex-wrap gap-x-2 ps-20 text-2xs text-muted-foreground tabular-nums">
      {pool.accounts.map((account) => (
        <span key={account.key}>
          {accountName(account)}{" "}
          <span className="text-foreground/70">{planCapacity(account.plan)}×</span>
        </span>
      ))}
    </div>
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
                  accountName(column.account),
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
