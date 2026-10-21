import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";

import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  type CompactAtBounds,
  compactAtFromPointer,
  isDoubleTap,
  nudgeCompactAt,
  resolveCompactLine,
} from "./compactLine.logic";

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * The segmented context readout inside the composer screen: filled segments for
 * the context in use, the amber compact line where the thread compacts, and the token
 * count. Empty until the thread reports usage. Dragging the line sets this thread's own
 * compact-at point.
 */
export function DeviceContextBar(props: {
  usage: ContextWindowSnapshot | null;
  /** This thread's own compact-at point; null follows the provider's setting. */
  threadCompactAt: number | null;
  /** The range the provider accepts for a compact-at point; null when it can't be set. */
  compactAtBounds: CompactAtBounds | null;
  /** Sets this thread's compact-at point; null returns it to the provider's setting. */
  onCompactAtChange?: ((compactAt: number | null) => void) | undefined;
  onOpenProviderSettings?: (() => void) | undefined;
  onCompact?: (() => void) | undefined;
  compactDisabled: boolean;
  compactDisabledReason: string | null;
  /** History the next send would summarise first; null when it sends as is. */
  compactBeforeSendTokens: number | null;
  keepFullHistory: boolean;
  onToggleKeepFullHistory: () => void;
  canOperateThread: boolean;
}) {
  const { usage } = props;
  const used = clampPercent(usage?.usedPercentage ?? 0);
  const compactLine = resolveCompactLine({
    threadCompactAt: props.threadCompactAt,
    appliedThreshold: usage?.autoCompactThreshold,
    bounds: props.compactAtBounds,
  });
  const readout = usage
    ? `${formatContextWindowTokens(usage.usedTokens)} / ${
        usage.maxTokens != null ? formatContextWindowTokens(usage.maxTokens) : "—"
      }`
    : "0 / —";
  const overloaded = used > 90;
  const maxTokens = usage?.maxTokens ?? null;
  return (
    <div className="device-context" data-overloaded={overloaded || undefined}>
      <div
        className="device-context__track"
        role="progressbar"
        aria-label="Context window usage"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
      >
        <div className="device-context__fill" style={{ width: `${used}%` }} />
        {compactLine.position !== null && maxTokens ? (
          <CompactLine
            position={compactLine.position}
            pending={compactLine.pending}
            unreported={compactLine.unreported}
            maxTokens={maxTokens}
            bounds={props.compactAtBounds}
            onChange={props.onCompactAtChange}
            onOpenProviderSettings={props.onOpenProviderSettings}
          />
        ) : null}
      </div>
      <span className="device-context__label">
        {readout}
        {props.threadCompactAt !== null && props.onCompactAtChange ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="device-context__compact"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => props.onCompactAtChange?.(null)}
                />
              }
            >
              use provider setting
            </TooltipTrigger>
            <TooltipPopup side="top">
              Compact this thread at the provider's auto-compact point again
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {props.compactBeforeSendTokens !== null ? (
          <CompactOnSendFlag
            tokens={props.compactBeforeSendTokens}
            armed={!props.keepFullHistory}
            disabled={!props.canOperateThread}
            onToggle={props.onToggleKeepFullHistory}
          />
        ) : props.onCompact && usage && used > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="device-context__compact"
                  aria-disabled={props.compactDisabled || undefined}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (!props.compactDisabled) props.onCompact?.();
                  }}
                />
              }
            >
              compact
            </TooltipTrigger>
            <TooltipPopup side="top">
              {props.compactDisabled && props.compactDisabledReason
                ? props.compactDisabledReason
                : "Summarize the history to free up context"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Whether the next send summarises the history first. Armed, it is a lit tag whose ✕
 * keeps the full history; disarmed, a dashed prompt to arm it again.
 */
function CompactOnSendFlag(props: {
  tokens: number;
  armed: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const tokens = formatContextWindowTokens(props.tokens);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="device-context__flag"
            aria-pressed={props.armed}
            disabled={props.disabled}
            aria-label={`Compact ${tokens} tokens of history before sending`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={props.onToggle}
          />
        }
      >
        {props.armed ? (
          <>
            ▸ compacts on send<span className="device-context__flag-off">✕</span>
          </>
        ) : (
          "compact on send?"
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {props.armed
          ? `Next send summarises ${tokens} tokens first. Click to keep the full history`
          : `Next send keeps all ${tokens} tokens. Click to compact first`}
      </TooltipPopup>
    </Tooltip>
  );
}

interface LineDrag {
  readonly value: number;
  readonly trackLeft: number;
  readonly trackWidth: number;
}

/**
 * The compact line. With `onChange` and bounds it drags (and arrow keys nudge it when
 * focused), saving the point for this thread on release; Escape cancels a drag. Double-click
 * or double-tap opens the provider's settings, where its own auto-compact point lives.
 */
function CompactLine(props: {
  position: number;
  pending: boolean;
  /** The provider reports no point, so the line marks only where dragging starts. */
  unreported: boolean;
  maxTokens: number;
  bounds: CompactAtBounds | null;
  onChange: ((compactAt: number | null) => void) | undefined;
  onOpenProviderSettings: (() => void) | undefined;
}) {
  const { bounds, onChange, onOpenProviderSettings } = props;
  const [drag, setDrag] = useState<LineDrag | null>(null);
  // Controlled so the tooltip stays up through a drag and closes on release.
  const [hoverOpen, setHoverOpen] = useState(false);
  const lastTapAt = useRef<number | null>(null);
  const dragging = drag !== null;
  const editable = onChange !== undefined && bounds !== null;
  const shown = drag?.value ?? props.position;
  const percent = clampPercent((shown / props.maxTokens) * 100);

  useEffect(() => {
    if (!dragging) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setDrag(null);
      setHoverOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [dragging]);

  const valueAt = (clientX: number, line: LineDrag) =>
    bounds === null
      ? line.value
      : compactAtFromPointer({
          offsetX: clientX - line.trackLeft,
          trackWidth: line.trackWidth,
          maxTokens: props.maxTokens,
          bounds,
        });
  const begin = (event: PointerEvent<HTMLSpanElement>) => {
    if (!editable || event.button !== 0) return;
    const track = event.currentTarget.closest<HTMLElement>(".device-context__track");
    if (!track) return;
    // Keep the composer's focus while the line is dragged.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = track.getBoundingClientRect();
    setDrag({ value: props.position, trackLeft: rect.left, trackWidth: rect.width });
  };
  const move = (event: PointerEvent<HTMLSpanElement>) => {
    if (!drag) return;
    setDrag({ ...drag, value: valueAt(event.clientX, drag) });
  };
  const openSettings = () => {
    setDrag(null);
    setHoverOpen(false);
    onOpenProviderSettings?.();
  };
  const end = (event: PointerEvent<HTMLSpanElement>) => {
    setHoverOpen(false);
    const value = drag === null ? props.position : valueAt(event.clientX, drag);
    setDrag(null);
    if (value !== props.position) {
      onChange?.(value);
      return;
    }
    // Touch has no dblclick, so a second tap that moved nothing stands in for it.
    if (event.pointerType !== "touch") return;
    const now = Date.now();
    if (isDoubleTap(lastTapAt.current, now)) {
      lastTapAt.current = null;
      openSettings();
    } else {
      lastTapAt.current = now;
    }
  };
  const cancel = () => {
    setDrag(null);
    setHoverOpen(false);
  };
  const nudge = (event: KeyboardEvent<HTMLSpanElement>) => {
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (direction === 0 || !editable) return;
    event.preventDefault();
    onChange?.(
      nudgeCompactAt({
        current: props.position,
        direction,
        large: event.shiftKey,
        maxTokens: props.maxTokens,
        bounds,
      }),
    );
  };

  const label =
    props.unreported && !dragging
      ? "The provider hasn't reported where it compacts"
      : `Compact at ${formatContextWindowTokens(shown)}`;
  return (
    <Tooltip open={dragging || hoverOpen} onOpenChange={setHoverOpen}>
      <TooltipTrigger
        render={
          <span
            className="device-context__marker"
            data-editable={editable || undefined}
            data-pending={props.pending || undefined}
            data-unreported={(props.unreported && !dragging) || undefined}
            data-dragging={dragging || undefined}
            style={{ left: `${percent}%` }}
            {...(editable
              ? {
                  role: "slider",
                  tabIndex: 0,
                  "aria-label": "Compact at",
                  "aria-valuemin": bounds.min,
                  "aria-valuemax": bounds.max,
                  "aria-valuenow": shown,
                  "aria-valuetext": label,
                }
              : {})}
            onPointerDown={begin}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={cancel}
            onKeyDown={nudge}
            onDoubleClick={openSettings}
          />
        }
      />
      <TooltipPopup side="top">
        {label}
        {props.pending ? (
          <span className="block text-muted-foreground">
            Applies when the provider next picks it up
          </span>
        ) : null}
        {!dragging ? (
          <span className="block text-muted-foreground">
            {editable ? "Drag to change it for this thread" : null}
            {editable && onOpenProviderSettings ? " · " : null}
            {onOpenProviderSettings ? "Double-click for provider settings" : null}
          </span>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
}
