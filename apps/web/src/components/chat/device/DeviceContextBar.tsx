import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { Button } from "../../ui/button";
import { Popover, PopoverPopup } from "../../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  type BlackholeStatusSnapshot,
  type ThreadCompactionSavings,
  parseBlackholeExtensionStatus,
} from "./blackholeStatus.logic";
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
  extensionStatuses?: ReadonlyArray<{ readonly key: string; readonly text: string }> | undefined;
  compactionSavings?: ThreadCompactionSavings | undefined;
  onRunBlackholeCommand?: ((command: string) => void) | undefined;
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
  /** The cheaper model that summarises that history; null when the conversation's own does. */
  compactionModelName: string | null;
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
  const blackhole = parseBlackholeExtensionStatus(props.extensionStatuses);
  return (
    <div
      className="device-context"
      data-overloaded={overloaded || undefined}
      style={{ "--used": used / 100 } as CSSProperties}
    >
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
            hasOwnPoint={props.threadCompactAt !== null}
            onChange={props.onCompactAtChange}
            onOpenProviderSettings={props.onOpenProviderSettings}
          />
        ) : null}
      </div>
      <span className="device-context__label">
        {readout}
        {blackhole ? (
          <BlackholeStatusControl
            status={blackhole}
            compactionSavings={props.compactionSavings}
            canOperateThread={props.canOperateThread}
            compactDisabled={props.compactDisabled}
            onRunCommand={props.onRunBlackholeCommand}
            onCompact={props.onCompact}
          />
        ) : null}
        {props.compactBeforeSendTokens !== null ? (
          <CompactOnSendFlag
            tokens={props.compactBeforeSendTokens}
            modelName={props.compactionModelName}
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
  modelName: string | null;
  armed: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const tokens = formatContextWindowTokens(props.tokens);
  const withModel = props.modelName ? ` with ${props.modelName}` : "";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="device-context__flag"
            aria-pressed={props.armed}
            disabled={props.disabled}
            aria-label={`Compact ${tokens} tokens of history${withModel} before sending`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={props.onToggle}
          />
        }
      >
        {props.armed ? (
          <>
            ▸ compacts on send{props.modelName ? ` · ${props.modelName}` : ""}
            <span className="device-context__flag-off">✕</span>
          </>
        ) : (
          "compact on send?"
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {props.armed
          ? `Next send summarises ${tokens} tokens first${withModel}. Click to keep the full history`
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
 * or double-tap returns a thread's own point to the provider's setting, or, when it already
 * follows it, opens the provider's settings where that point lives.
 */
function CompactLine(props: {
  position: number;
  pending: boolean;
  /** The provider reports no point, so the line marks only where dragging starts. */
  unreported: boolean;
  maxTokens: number;
  bounds: CompactAtBounds | null;
  /** This thread sets its own point, so it can be reset to the provider's. */
  hasOwnPoint: boolean;
  onChange: ((compactAt: number | null) => void) | undefined;
  onOpenProviderSettings: (() => void) | undefined;
}) {
  const { bounds, hasOwnPoint, onChange, onOpenProviderSettings } = props;
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
  const resetOrOpenSettings = () => {
    setDrag(null);
    setHoverOpen(false);
    if (hasOwnPoint && onChange) onChange(null);
    else onOpenProviderSettings?.();
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
      resetOrOpenSettings();
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
            onDoubleClick={resetOrOpenSettings}
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
            {editable && (hasOwnPoint || onOpenProviderSettings) ? " · " : null}
            {hasOwnPoint && editable
              ? "Double-click to use the provider's setting"
              : onOpenProviderSettings
                ? "Double-click for provider settings"
                : null}
          </span>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
}

function formatBlackholePillLabel(status: BlackholeStatusSnapshot): string {
  if (!status.memoryEnabled) return "off";
  if (status.observerFraction !== null) return `${Math.round(status.observerFraction * 100)}%`;
  return "";
}

/** A black hole seen edge-on: a dark core inside a tilted accretion ring. */
function BlackholeGlyph() {
  return (
    <svg className="device-context__bh-glyph" viewBox="0 0 16 12" aria-hidden>
      <ellipse
        cx="8"
        cy="6"
        rx="7"
        ry="2.6"
        transform="rotate(-14 8 6)"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="8" cy="6" r="3.4" className="device-context__bh-core" />
      <path
        d="M1 6 A7 2.6 0 0 0 15 6"
        transform="rotate(-14 8 6)"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function BlackholeStatusControl(props: {
  status: BlackholeStatusSnapshot;
  compactionSavings: ThreadCompactionSavings | undefined;
  canOperateThread: boolean;
  compactDisabled: boolean;
  onRunCommand: ((command: string) => void) | undefined;
  onCompact: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [pillEl, setPillEl] = useState<HTMLButtonElement | null>(null);
  const { status, compactionSavings } = props;
  const pillState = status.memoryEnabled ? "idle" : "off";

  const runAndClose = (command: string) => {
    setOpen(false);
    props.onRunCommand?.(command);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <button
        ref={setPillEl}
        type="button"
        className="device-context__bh-pill"
        data-state={pillState}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Blackhole observational memory details"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
      >
        <BlackholeGlyph />
        {formatBlackholePillLabel(status) ? (
          <span className="device-context__bh-label">{formatBlackholePillLabel(status)}</span>
        ) : null}
      </button>
      <PopoverPopup anchor={pillEl} side="top" align="end" width="md" padding="compact">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">
              Blackhole Observational Memory
            </span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-2xs text-muted-foreground">
                {status.worker?.kind === "running"
                  ? `Running ${status.worker.phase}…`
                  : status.worker?.kind === "done"
                    ? `Settled${status.worker.delta !== null ? ` (+${status.worker.delta})` : ""}`
                    : status.memoryEnabled
                      ? "Active"
                      : "Paused"}
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-expanded={guideOpen}
                onClick={() => setGuideOpen((current) => !current)}
              >
                {guideOpen ? "Hide guide" : "Guide"}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <BlackholeGauge
              label="Observer"
              fraction={status.observerFraction}
              disabled={!status.memoryEnabled}
              accent="amber"
            />
            <BlackholeGauge
              label="Obs Pool"
              fraction={status.poolFraction}
              disabled={!status.memoryEnabled}
              accent="ink"
            />
            <BlackholeGauge
              label="Compaction"
              fraction={status.compactionFraction}
              disabled={false}
              accent="ink"
            />
          </div>

          {guideOpen ? (
            <div className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2.5 py-2 text-2xs leading-relaxed text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">Observer %:</span> New tokens since
                the last observer pass. At 100%, a background model records key facts and resets to
                0%.
              </p>
              <p>
                <span className="font-medium text-foreground">Obs Pool %:</span> Saved observation
                buffer fill. As it fills, Reflector condenses older notes and Dropper trims stale
                ones.
              </p>
              <p>
                <span className="font-medium text-foreground">Compaction %:</span> Context fill
                toward Blackhole's auto-compact point. At 100%, older turns fold into a structural
                summary at zero LLM cost.
              </p>
            </div>
          ) : null}

          {compactionSavings ? (
            <div className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-2xs">
              <span className="text-muted-foreground">Context freed in thread</span>
              <span className="font-mono tabular-nums text-foreground">
                {compactionSavings.compactionCount > 0
                  ? `${formatContextWindowTokens(compactionSavings.freedTokens)} (${compactionSavings.compactionCount} ${
                      compactionSavings.compactionCount === 1 ? "compaction" : "compactions"
                    })`
                  : "0 (no compactions yet)"}
              </span>
            </div>
          ) : null}

          {props.onRunCommand || props.onCompact ? (
            <div className="flex items-center justify-end gap-1.5 border-t border-border/60 pt-2">
              {props.onRunCommand ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={!props.canOperateThread}
                  onClick={() =>
                    runAndClose(status.memoryEnabled ? "/blackhole om-off" : "/blackhole om-on")
                  }
                >
                  {status.memoryEnabled ? "Pause memory" : "Resume memory"}
                </Button>
              ) : null}
              {props.onCompact ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={props.compactDisabled}
                  onClick={() => {
                    setOpen(false);
                    props.onCompact?.();
                  }}
                >
                  Compact
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function BlackholeGauge(props: {
  label: string;
  fraction: number | null;
  disabled: boolean;
  accent: "amber" | "ink";
}) {
  const pct = props.fraction !== null ? Math.round(clampPercent(props.fraction * 100)) : null;
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-muted/60 px-2.5 py-2">
      <div className="flex items-center justify-between gap-1 text-2xs">
        <span className="text-muted-foreground">{props.label}</span>
        <span className="font-mono tabular-nums text-foreground">
          {props.disabled ? "off" : pct !== null ? `${pct}%` : "-"}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/10">
        <div
          className={
            props.accent === "amber"
              ? "h-full rounded-full bg-warning transition-[width] duration-150"
              : "h-full rounded-full bg-foreground/55 transition-[width] duration-150"
          }
          style={{ width: `${props.disabled || pct === null ? 0 : pct}%` }}
        />
      </div>
    </div>
  );
}
