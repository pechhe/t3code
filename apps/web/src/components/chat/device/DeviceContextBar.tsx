import type { CSSProperties } from "react";

import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { formatContextWindowCompactionMessage } from "../ContextWindowMeter.logic";

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * The segmented context readout inside the composer screen: filled segments for
 * the context in use, an amber marker where the provider compacts on its own,
 * lines where context rollover asks for a handoff, and the token count. Empty
 * until the thread reports usage.
 */
export function DeviceContextBar(props: {
  usage: ContextWindowSnapshot | null;
  /** Context sizes where rollover asks for a handoff: soft at a break, hard now. */
  rollover: { readonly soft: number; readonly hard: number } | null;
  modelDisplayName: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled: boolean;
  compactDisabledReason: string | null;
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
  const rolloverLines =
    props.rollover && maxTokens
      ? ([
          {
            kind: "soft",
            left: clampPercent((props.rollover.soft / maxTokens) * 100),
            label: `Rollover asks for a handoff at the next break past ${formatContextWindowTokens(props.rollover.soft)}`,
          },
          {
            kind: "hard",
            left: clampPercent((props.rollover.hard / maxTokens) * 100),
            label: `Rollover asks for a handoff right away at ${formatContextWindowTokens(props.rollover.hard)}`,
          },
        ] as const)
      : [];

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
        {rolloverLines.map((line) => (
          <Tooltip key={line.kind}>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    "device-context__rollover",
                    line.kind === "hard" && "device-context__rollover--hard",
                  )}
                  style={{ left: `${line.left}%` }}
                />
              }
            />
            <TooltipPopup side="top">{line.label}</TooltipPopup>
          </Tooltip>
        ))}
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
        {props.onCompact && usage && used > 0 ? (
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
