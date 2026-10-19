import { type CSSProperties, type KeyboardEvent, type PointerEvent, useState } from "react";

import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { formatContextWindowCompactionMessage } from "../ContextWindowMeter.logic";
import {
  dragRolloverBand,
  type RolloverBandPart,
  type RolloverBandThresholds,
} from "./rolloverBand.logic";

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * The segmented context readout inside the composer screen: filled segments for
 * the context in use, an amber marker where the provider compacts on its own,
 * a shaded band where context rollover nudges the agent, and the token count. Empty
 * until the thread reports usage. Dragging the band, or either of its edges, sets this
 * thread's own rollover thresholds.
 */
export function DeviceContextBar(props: {
  usage: ContextWindowSnapshot | null;
  /** Context sizes where rollover nudges the agent: soft at a break, hard now. */
  rollover: RolloverBandThresholds | null;
  /** Whether the thread has its own thresholds rather than the settings'. */
  rolloverCustom?: boolean | undefined;
  /** Sets this thread's thresholds; null returns it to the settings. */
  onRolloverChange?: ((thresholds: RolloverBandThresholds | null) => void) | undefined;
  modelDisplayName: string | null;
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
  const marker =
    usage?.autoCompactThreshold != null && usage.maxTokens
      ? clampPercent((usage.autoCompactThreshold / usage.maxTokens) * 100)
      : null;
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
        {props.rollover && maxTokens ? (
          <RolloverBand
            thresholds={props.rollover}
            maxTokens={maxTokens}
            custom={props.rolloverCustom === true}
            onChange={props.onRolloverChange}
          />
        ) : null}
        {marker !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className="device-context__marker"
                  style={{ left: `${marker}%` } as CSSProperties}
                />
              }
            />
            <TooltipPopup side="top">
              {formatContextWindowCompactionMessage(
                props.modelDisplayName,
                usage?.autoCompactThreshold ?? null,
              )}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <span className="device-context__label">
        {readout}
        {props.rolloverCustom && props.onRolloverChange ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="device-context__compact"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => props.onRolloverChange?.(null)}
                />
              }
            >
              reset rollover
            </TooltipTrigger>
            <TooltipPopup side="top">Use the rollover settings again for this thread</TooltipPopup>
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

interface BandDrag {
  readonly part: RolloverBandPart;
  readonly startX: number;
  readonly trackWidth: number;
  readonly start: RolloverBandThresholds;
  readonly current: RolloverBandThresholds;
}

/**
 * The rollover band: soft threshold at its left edge, hard at its right. With
 * `onChange`, its edges and body drag (and arrow keys nudge the focused edge), and the
 * result is saved for this thread when the drag ends; double-click resets it.
 */
function RolloverBand(props: {
  thresholds: RolloverBandThresholds;
  maxTokens: number;
  custom: boolean;
  onChange: ((thresholds: RolloverBandThresholds | null) => void) | undefined;
}) {
  const [drag, setDrag] = useState<BandDrag | null>(null);
  // Controlled so the tooltip stays up through a drag and closes on release.
  const [hoverOpen, setHoverOpen] = useState(false);
  // A released drag holds its place until the saved thresholds come back from the server.
  const [released, setReleased] = useState<{
    readonly from: RolloverBandThresholds;
    readonly value: RolloverBandThresholds;
  } | null>(null);
  const shown =
    drag?.current ??
    (released !== null && released.from === props.thresholds ? released.value : props.thresholds);
  const percent = (tokens: number) => clampPercent((tokens / props.maxTokens) * 100);
  const left = percent(shown.soft);
  const width = Math.max(0, percent(shown.hard) - left);
  const editable = props.onChange !== undefined;
  const label = `Rollover asks the agent to prepare for compaction at the next break past ${formatContextWindowTokens(shown.soft)}, and right away at ${formatContextWindowTokens(shown.hard)}${
    props.custom ? " (this thread only)" : ""
  }`;

  const begin = (part: RolloverBandPart) => (event: PointerEvent<HTMLSpanElement>) => {
    if (!editable || event.button !== 0) return;
    const track = event.currentTarget.closest<HTMLElement>(".device-context__track");
    if (!track) return;
    // Keep the composer's focus, and let the edge win over the band beneath it.
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      part,
      startX: event.clientX,
      trackWidth: track.getBoundingClientRect().width,
      start: props.thresholds,
      current: props.thresholds,
    });
  };
  const move = (event: PointerEvent<HTMLSpanElement>) => {
    if (!drag || drag.trackWidth === 0) return;
    const deltaTokens = ((event.clientX - drag.startX) / drag.trackWidth) * props.maxTokens;
    setDrag({
      ...drag,
      current: dragRolloverBand({
        start: drag.start,
        part: drag.part,
        deltaTokens,
        maxTokens: props.maxTokens,
      }),
    });
  };
  const end = () => {
    if (!drag) return;
    setDrag(null);
    setHoverOpen(false);
    const { current, start } = drag;
    if (current.soft === start.soft && current.hard === start.hard) return;
    setReleased({ from: props.thresholds, value: current });
    props.onChange?.(current);
  };
  const cancel = () => {
    setDrag(null);
    setHoverOpen(false);
  };
  const nudge = (part: "soft" | "hard") => (event: KeyboardEvent<HTMLSpanElement>) => {
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (direction === 0 || !editable) return;
    event.preventDefault();
    props.onChange?.(
      dragRolloverBand({
        start: props.thresholds,
        part,
        deltaTokens: direction * props.maxTokens * (event.shiftKey ? 0.05 : 0.01),
        maxTokens: props.maxTokens,
      }),
    );
  };
  const edge = (part: "soft" | "hard") =>
    editable ? (
      <span
        role="slider"
        tabIndex={0}
        aria-label={part === "soft" ? "Rollover at the next break" : "Rollover right away"}
        aria-valuemin={0}
        aria-valuemax={props.maxTokens}
        aria-valuenow={shown[part]}
        aria-valuetext={formatContextWindowTokens(shown[part])}
        className={`device-context__rollover-edge device-context__rollover-edge--${part}`}
        onPointerDown={begin(part)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={cancel}
        onKeyDown={nudge(part)}
      />
    ) : null;

  return (
    <Tooltip open={drag !== null || hoverOpen} onOpenChange={setHoverOpen}>
      <TooltipTrigger
        render={
          <span
            className="device-context__rollover"
            data-editable={editable || undefined}
            data-custom={props.custom || undefined}
            data-dragging={drag ? "" : undefined}
            style={{ left: `${left}%`, width: `${width}%` }}
            onPointerDown={begin("band")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={cancel}
            onDoubleClick={() => {
              if (props.custom) props.onChange?.(null);
            }}
          />
        }
      >
        {edge("soft")}
        {edge("hard")}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {label}
        {editable && !drag ? (
          <span className="block text-muted-foreground">
            Drag to change it for this thread{props.custom ? "; double-click to reset" : ""}
          </span>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
}
