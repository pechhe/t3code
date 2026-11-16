import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { getDocumentActivity, subscribeDocumentActivity } from "~/lib/documentActivity";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { Button } from "../../ui/button";
import { Popover, PopoverPopup } from "../../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  type BlackholeStatusSnapshot,
  type BlackholeWorkerPhase,
  type ThreadCompactionSavings,
  parseBlackholeExtensionStatus,
} from "./blackholeStatus.logic";
import { type CompactionPullState, advanceCompactionPull } from "./compactionPull.logic";
import { playCompactionPull } from "./compactionPull";
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

/** What the user last saw of each thread's context, kept while the app runs. */
const seenPullStates = new Map<string, CompactionPullState>();
const SEEN_PULL_STATES_MAX = 200;

function rememberPullState(threadKey: string, state: CompactionPullState) {
  seenPullStates.delete(threadKey);
  seenPullStates.set(threadKey, state);
  if (seenPullStates.size <= SEEN_PULL_STATES_MAX) return;
  const oldest = seenPullStates.keys().next().value;
  if (oldest !== undefined) seenPullStates.delete(oldest);
}

function isUserWatching() {
  const activity = getDocumentActivity();
  return activity.visible && activity.focused;
}

/**
 * The segmented context readout inside the composer screen: filled segments for
 * the context in use, the amber compact line where the thread compacts, and the token
 * count. Empty until the thread reports usage. Dragging the line sets this thread's own
 * compact-at point.
 */
export function DeviceContextBar(props: {
  /** The thread on show, so another thread's numbers are never read as this one's compaction. */
  threadKey: string;
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
  /** A compaction of this thread is under way. */
  compacting: boolean;
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
  const [pullReadout, setPullReadout] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const watching = useSyncExternalStore(subscribeDocumentActivity, isUserWatching, () => true);
  const usageKnown = usage !== null;
  const usedTokens = usage?.usedTokens ?? 0;
  const windowTokens = usage?.maxTokens ?? null;
  const compactionCount = props.compactionSavings?.compactionCount ?? 0;
  const blackhole = parseBlackholeExtensionStatus(props.extensionStatuses);
  const hasBlackhole = blackhole !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a completed compaction plays a one-off animation on the bar's own DOM nodes
  useEffect(() => {
    // Only what the user watched counts as seen, so a compaction they missed plays on return.
    if (!watching || !usageKnown) return;
    const next = advanceCompactionPull(seenPullStates.get(props.threadKey) ?? null, {
      usedTokens,
      compactionCount,
    });
    const root = rootRef.current;
    const track = root?.querySelector<HTMLElement>(".device-context__track");
    const hole = hasBlackhole ? root?.querySelector(".device-context__bh-glyph") : null;
    const playable = windowTokens && track && hole;
    // A pull the bar cannot draw yet stays unseen, so it plays once the glyph is there.
    if (next.pull === null || playable) rememberPullState(props.threadKey, next.state);
    if (next.pull === null || !windowTokens || !track || !hole) return;
    return playCompactionPull({
      track,
      hole,
      fromShare: next.pull.fromTokens / windowTokens,
      toShare: next.pull.toTokens / windowTokens,
      onProgress: (share) =>
        setPullReadout(share === null ? null : formatContextWindowTokens(share * windowTokens)),
    });
  }, [
    props.threadKey,
    watching,
    usageKnown,
    usedTokens,
    compactionCount,
    windowTokens,
    hasBlackhole,
  ]);
  const readout = usage
    ? `${pullReadout ?? formatContextWindowTokens(usage.usedTokens)} / ${
        usage.maxTokens != null ? formatContextWindowTokens(usage.maxTokens) : "-"
      }`
    : "0 / -";
  const overloaded = used > 90;
  const maxTokens = usage?.maxTokens ?? null;
  return (
    <div
      ref={rootRef}
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
            compactionShare={
              usage && compactLine.position !== null && !compactLine.unreported
                ? usage.usedTokens / compactLine.position
                : blackhole.compactionFraction
            }
            compactionSavings={props.compactionSavings}
            canOperateThread={props.canOperateThread}
            compactDisabled={props.compactDisabled}
            onRunCommand={props.onRunBlackholeCommand}
            onCompact={props.onCompact}
            compacting={props.compacting}
          />
        ) : null}
        {props.compacting ? (
          <span className="device-context__compacting" role="status">
            compacting…
          </span>
        ) : props.compactBeforeSendTokens !== null ? (
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape cancels a drag through a window listener that lives only while dragging
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

const BLACKHOLE_WORK: Record<BlackholeWorkerPhase, { pill: string; status: string }> = {
  observer: { pill: "noting", status: "Writing notes…" },
  reflector: { pill: "condensing", status: "Condensing notes…" },
  dropper: { pill: "trimming", status: "Trimming old notes…" },
  compact: { pill: "compacting", status: "Compacting…" },
};

/** A black hole seen edge-on: a dark core in its ring of light, crossed by the accretion disc. */
/** A tilted accretion disc that passes behind and in front of the hole; it spins while compacting. */
function BlackholeGlyph(props: { compacting: boolean }) {
  const id = useId();
  const doppler = `${id}-doppler`;
  const halo = `${id}-halo`;
  const glow = `${id}-glow`;
  const back = `${id}-back`;
  const front = `${id}-front`;
  const disc = (
    <>
      <circle
        className="device-context__bh-disc"
        r="14.4"
        stroke={`url(#${doppler})`}
        strokeWidth="4.6"
        strokeOpacity="0.38"
      />
      <circle
        className="device-context__bh-disc"
        r="9.4"
        stroke={`url(#${doppler})`}
        strokeWidth="5.2"
      />
    </>
  );
  return (
    <svg
      className="device-context__bh-glyph"
      viewBox="0 0 34 22"
      data-compacting={props.compacting || undefined}
      ref={props.compacting ? observeVisibleAnimation : undefined}
      aria-hidden
    >
      <defs>
        <linearGradient id={doppler}>
          <stop offset="0" stopColor="currentColor" />
          <stop offset="0.6" stopColor="currentColor" stopOpacity="0.85" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.3" />
        </linearGradient>
        <linearGradient id={halo} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" />
          <stop offset="0.5" stopColor="currentColor" stopOpacity="0.75" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.3" />
        </linearGradient>
        <radialGradient id={glow}>
          <stop offset="0.5" stopColor="currentColor" stopOpacity="0.5" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
        <clipPath id={back}>
          <rect x="-20" y="-20" width="40" height="20" />
        </clipPath>
        <clipPath id={front}>
          <rect x="-20" y="0" width="40" height="20" />
        </clipPath>
      </defs>
      <g transform="translate(17 11) rotate(-9)" fill="none">
        <circle r="10.5" fill={`url(#${glow})`} opacity="0.5" />
        <g clipPath={`url(#${back})`} opacity="0.55">
          <g transform="scale(1 .3)">
            {disc}
            <circle
              className="device-context__bh-spin"
              r="12"
              strokeWidth="3"
              strokeDasharray="14 23.7"
            />
          </g>
        </g>
        <circle
          className="device-context__bh-halo"
          r="6.5"
          stroke={`url(#${halo})`}
          strokeWidth="1.3"
        />
        <circle className="device-context__bh-core" r="5.8" />
        <g clipPath={`url(#${front})`}>
          <g transform="scale(1 .3)">
            {disc}
            <circle
              className="device-context__bh-spin"
              r="14.4"
              strokeWidth="4"
              strokeDasharray="17 28.2"
            />
            <circle
              className="device-context__bh-spin"
              data-orbit="inner"
              r="9.4"
              strokeWidth="5.2"
              strokeDasharray="11 18.5"
            />
          </g>
        </g>
      </g>
    </svg>
  );
}

function BlackholeStatusControl(props: {
  status: BlackholeStatusSnapshot;
  /** Context in use as a share of the point where the thread compacts. */
  compactionShare: number | null;
  compactionSavings: ThreadCompactionSavings | undefined;
  canOperateThread: boolean;
  compactDisabled: boolean;
  onRunCommand: ((command: string) => void) | undefined;
  onCompact: (() => void) | undefined;
  compacting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pillEl, setPillEl] = useState<HTMLButtonElement | null>(null);
  const { status, compactionSavings } = props;
  const work = status.worker?.kind === "running" ? BLACKHOLE_WORK[status.worker.phase] : null;
  // The bar's own "compacting…" already names a compaction.
  const pillLabel = props.compacting ? null : !status.memoryEnabled ? "off" : (work?.pill ?? null);
  const wrote =
    status.worker?.kind === "done" && status.worker.phase === "observer"
      ? status.worker.delta
      : null;
  const statusLine = work
    ? work.status
    : !status.memoryEnabled
      ? "Paused"
      : wrote
        ? `Wrote ${wrote} ${wrote === 1 ? "note" : "notes"}`
        : "Up to date";

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
        data-state={props.compacting || work ? "working" : !status.memoryEnabled ? "off" : "idle"}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Memory"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
      >
        <BlackholeGlyph compacting={props.compacting} />
        {pillLabel}
      </button>
      <PopoverPopup anchor={pillEl} side="top" align="end" width="md" padding="compact">
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-semibold text-foreground">Memory</span>
            <span
              className={
                work
                  ? "text-2xs whitespace-nowrap text-warning"
                  : "text-2xs whitespace-nowrap text-muted-foreground"
              }
            >
              {statusLine}
            </span>
          </div>

          <dl className="grid grid-cols-[auto_minmax(0,1fr)_4ch] items-center gap-x-2.5 gap-y-1.5 text-2xs">
            <BlackholeMeter
              label="Next notes"
              hint="New context since notes were last written. At 100% a background model writes more."
              fraction={status.observerFraction}
              off={!status.memoryEnabled}
              live={status.worker?.kind === "running" && status.worker.phase === "observer"}
            />
            <BlackholeMeter
              label="Notes stored"
              hint="How full the note store is. As it fills, older notes are condensed and stale ones dropped."
              fraction={status.poolFraction}
              off={!status.memoryEnabled}
              live={false}
            />
            <BlackholeMeter
              label="Until compaction"
              hint="Context in use towards the line on the bar, where older turns fold into a summary."
              fraction={props.compactionShare}
              off={false}
              live={false}
            />
          </dl>

          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs whitespace-nowrap text-muted-foreground/70">
              {compactionSavings && compactionSavings.compactionCount > 0
                ? `${formatContextWindowTokens(compactionSavings.freedTokens)} freed so far`
                : null}
            </span>
            <div className="flex items-center gap-1.5">
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
                  Compact now
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function BlackholeMeter(props: {
  label: string;
  hint: string;
  fraction: number | null;
  off: boolean;
  live: boolean;
}) {
  const pct = props.fraction !== null ? Math.round(clampPercent(props.fraction * 100)) : null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<dt className="text-muted-foreground" />}>
          {props.label}
        </TooltipTrigger>
        <TooltipPopup side="left">{props.hint}</TooltipPopup>
      </Tooltip>
      <dd className="h-[3px] overflow-hidden rounded-full bg-foreground/10">
        <div
          className={
            props.live
              ? "h-full rounded-full bg-warning transition-[width] duration-150"
              : "h-full rounded-full bg-foreground/55 transition-[width] duration-150"
          }
          style={{ width: `${props.off || pct === null ? 0 : pct}%` }}
        />
      </dd>
      <dd className="text-right font-mono tabular-nums text-foreground">
        {props.off ? "off" : pct !== null ? `${pct}%` : "-"}
      </dd>
    </>
  );
}
