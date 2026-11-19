import { useAtomValue } from "@effect/atom-react";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import { collectLimitAccounts, collectLimitPools } from "@t3tools/shared/usageLimits";
import { formatDuration } from "@t3tools/shared/usageLimitsCopy";
import { useNavigate } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { observeResize } from "../../lib/observeResize";
import { environmentPresentations } from "../../state/presentation";
import { providerClients } from "../settings/providerDriverMeta";
import { ArrowRightIcon, SlidersHorizontalIcon } from "lucide-react";

import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_CARD_GAP,
  THREAD_DETAILS_CARD_WIDTH,
} from "../chat/threadDetailsCardLayout";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { useChatCanvas } from "../chat/ChatCanvasContext";
import { type UsageCornerRow, usageCornerRows } from "./usageCornerRows";

// Same width and edge as the thread details card above it, so the two read as one column.
const CARD_WIDTH_PX = THREAD_DETAILS_CARD_WIDTH;
const GUTTER_MARGIN_PX = THREAD_DETAILS_CARD_GAP;

/**
 * Where the column sits in the composer overlay: in the gutter right of the centred composer,
 * level with its bottom edge, or nowhere when the gutter is too narrow to hold it. `top` is
 * the column's bottom edge measured from the chat canvas top, which bounds how tall it grows.
 */
function useGutterPlacement(
  overlay: HTMLElement | null,
): { readonly bottom: number; readonly top: number } | null {
  const subscribe = (notify: () => void) => {
    const stack = overlay?.querySelector<HTMLElement>("[data-chat-composer-stack]");
    if (!overlay || !stack) return () => {};
    const canvas = overlay.closest<HTMLElement>("[data-chat-canvas]");
    return observeResize(canvas ? [overlay, stack, canvas] : [overlay, stack], notify);
  };
  const getSnapshot = () => {
    const stack = overlay?.querySelector<HTMLElement>("[data-chat-composer-stack]");
    if (!overlay || !stack) return null;
    const canvas = overlay.closest<HTMLElement>("[data-chat-canvas]");
    const lane = overlay.getBoundingClientRect();
    const composer = stack.getBoundingClientRect();
    if (lane.right - composer.right < CARD_WIDTH_PX + GUTTER_MARGIN_PX * 2) return null;
    const bottom = Math.max(0, Math.round(lane.bottom - composer.bottom));
    const top = Math.round(lane.bottom - bottom - (canvas?.getBoundingClientRect().top ?? 0));
    return `${bottom}:${top}`;
  };
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => null);
  if (snapshot === null) return null;
  const separator = snapshot.indexOf(":");
  return {
    bottom: Number(snapshot.slice(0, separator)),
    top: Number(snapshot.slice(separator + 1)),
  };
}

/**
 * Subscription limits at a glance beside the composer: one figure per provider, what is left
 * in its tightest window summed across its accounts, with each account's own figure beside it.
 */
export function UsageCorner({ overlay }: { readonly overlay: HTMLElement | null }) {
  const placement = useGutterPlacement(overlay);
  const canvas = useChatCanvas();
  // Below the inline details card, else below the find bar when it is open.
  const columnTop = canvas?.detailsCardBottom ?? canvas?.detailsCardTopInset ?? 0;
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  // The minute clock keeps the reset countdowns true without a render per second.
  const now = Date.parse(`${useNowMinute()}:00.000Z`);
  const navigate = useNavigate();
  const hiddenRows = useClientSettings((settings) => settings.usageCornerHiddenRows);
  if (placement === null) return null;
  const rows = usageCornerRows(collectLimitPools(collectLimitAccounts(presentations), now), now);
  if (rows.length === 0) return null;
  const shownRows = rows.filter((row) => !hiddenRows.includes(row.id));
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
      <div className="dropdown-glass pointer-events-auto flex-none overflow-hidden rounded-3xl text-xs">
        <ThreadDetailsSection
          headingId="usage-corner-heading"
          title="Usage left"
          separated={false}
          actions={
            <>
              <UsageCornerRowsMenu rows={rows} hiddenRows={hiddenRows} />
              <ThreadDetailsControl
                part="icon"
                aria-label="Open Usage"
                onClick={() => void navigate({ to: "/usage" })}
              >
                <ArrowRightIcon className="size-3.5 text-muted-foreground" />
              </ThreadDetailsControl>
            </>
          }
        >
          <div className="flex flex-col gap-1.5 px-1.5">
            {shownRows.map((row) => (
              <UsageCornerLine key={row.id} row={row} now={now} />
            ))}
          </div>
        </ThreadDetailsSection>
      </div>
    </div>
  );
}

function rowName(row: UsageCornerRow): string {
  return row.slotName ?? providerClients.get(row.pool.driver)?.label ?? String(row.pool.driver);
}

function UsageCornerRowIcon({ row }: { readonly row: UsageCornerRow }) {
  return (
    <ProviderInstanceIcon
      driverKind={row.icon.driverKind}
      subProvider={row.icon.subProvider}
      displayName={rowName(row)}
      className="size-3.5"
      iconClassName="size-3.5"
    />
  );
}

/** Choosing which rows the card shows; every row stays listed here so a hidden one can return. */
function UsageCornerRowsMenu(props: {
  readonly rows: readonly UsageCornerRow[];
  readonly hiddenRows: readonly string[];
}) {
  return (
    <Menu>
      <MenuTrigger render={<ThreadDetailsControl part="icon" aria-label="Choose what to show" />}>
        <SlidersHorizontalIcon className="size-3.5 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Show in Usage left</MenuGroupLabel>
          {props.rows.map((row) => (
            <MenuCheckboxItem
              key={row.id}
              checked={!props.hiddenRows.includes(row.id)}
              onCheckedChange={(checked) => {
                const hidden = getClientSettings().usageCornerHiddenRows.filter(
                  (id) => id !== row.id,
                );
                updateClientSettings({
                  usageCornerHiddenRows: checked ? hidden : [...hidden, row.id],
                });
              }}
            >
              <span className="flex items-center gap-2">
                <UsageCornerRowIcon row={row} />
                {rowName(row)}
              </span>
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function UsageCornerLine({ row, now }: { readonly row: UsageCornerRow; readonly now: number }) {
  const provider = rowName(row);
  const out = row.remainingPercent === 0;
  const back = row.backAt === null ? null : formatDuration(row.backAt - now);
  const accounts = row.accounts.length > 1 ? row.accounts : [];
  const summary = out
    ? `out${back ? `, back in ${back}` : ""}`
    : `${row.remainingPercent}% left${row.ahead ? ", spending faster than an even rate" : ""}`;
  return (
    <div
      role="group"
      aria-label={[
        `${provider}: ${summary}`,
        ...accounts.map((entry) => `${entry.name} ${entry.remainingPercent}%`),
      ].join("; ")}
      className="flex items-center gap-2 tabular-nums"
    >
      <UsageCornerRowIcon row={row} />
      <span aria-hidden className="min-w-0 truncate text-muted-foreground">
        {provider}
      </span>
      <span aria-hidden className="ms-auto flex shrink-0 gap-2 text-2xs text-muted-foreground">
        {accounts.map((entry) => {
          const accent = normalizeProviderAccentColor(entry.account.accentColor);
          return (
            <span key={entry.account.key} className="inline-flex items-center gap-1">
              {/* Without an accent colour the dots would match, so the name's initial marks it. */}
              {accent ? (
                <span className="size-1.5 rounded-full" style={{ backgroundColor: accent }} />
              ) : (
                <span className="font-medium text-foreground/70">
                  {entry.name.slice(0, 1).toUpperCase()}
                </span>
              )}
              {entry.remainingPercent}
            </span>
          );
        })}
      </span>
      <span
        aria-hidden
        className={
          out
            ? "font-semibold text-destructive"
            : row.ahead
              ? "font-semibold text-warning-foreground"
              : "font-semibold text-foreground"
        }
      >
        {out ? "out" : `${row.remainingPercent}%`}
        {out && back ? <span className="font-normal text-muted-foreground"> · {back}</span> : null}
      </span>
    </div>
  );
}
