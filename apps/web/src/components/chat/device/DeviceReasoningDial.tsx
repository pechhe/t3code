import { forwardRef, useImperativeHandle, type CSSProperties } from "react";
import type { ProviderOptionDescriptor } from "@t3tools/contracts";

import { playRotary } from "~/lib/interfaceSounds";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { useTraitsControls } from "../TraitsPicker";
import { resolveTraitsControlProps, type TraitsRenderInput } from "../composerProviderState";

export interface DeviceReasoningDialHandle {
  /** Step the dial one setting; `1` turns it up, `-1` down. Stops at either end. */
  step: (direction: 1 | -1) => void;
}

type EffortOption = Extract<ProviderOptionDescriptor, { type: "select" }>["options"][number];

const SHORT_LABELS: Readonly<Record<string, string>> = {
  none: "OFF",
  off: "OFF",
  minimal: "MIN",
  low: "LOW",
  medium: "MED",
  high: "HIGH",
  xhigh: "XHIGH",
  max: "MAX",
  ultrathink: "ULTRA",
};
const RADIUS = 40;

function shortLabel(option: EffortOption): string {
  return SHORT_LABELS[option.id.toLowerCase()] ?? option.label.toUpperCase().slice(0, 6);
}

// The first setting sits at nine o'clock and the rest fan clockwise from 225° to 405°.
function clockAngle(index: number, count: number): number {
  if (index === 0) return 180;
  if (count <= 2) return 0;
  return 225 + ((index - 1) * 180) / Math.max(1, count - 2);
}

/**
 * The reasoning knob: one stop per effort the selected model offers. Clicking a
 * label selects it, clicking the knob turns it up a stop (wrapping at the top),
 * and ⌘↑/⌘↓ step it through the handle.
 */
export const DeviceReasoningDial = forwardRef<DeviceReasoningDialHandle, TraitsRenderInput>(
  function DeviceReasoningDial(input, ref) {
    const props = resolveTraitsControlProps(input);
    return props ? <ReasoningDial ref={ref} {...props} /> : null;
  },
);

const ReasoningDial = forwardRef<
  DeviceReasoningDialHandle,
  NonNullable<ReturnType<typeof resolveTraitsControlProps>>
>(function ReasoningDial(props, ref) {
  const controls = useTraitsControls(props);
  const descriptor = controls.primarySelectDescriptor;
  const options = descriptor?.options ?? [];
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.id === controls.primarySelectedValue),
  );
  const disabled = descriptor === null || controls.ultrathinkInBodyText;

  const select = (index: number) => {
    const option = options[index];
    if (!descriptor || !option || disabled) return;
    playRotary();
    controls.handleSelectChange(descriptor, option.id);
  };

  useImperativeHandle(ref, () => ({
    step: (direction) => {
      const next = Math.min(options.length - 1, Math.max(0, activeIndex + direction));
      if (next !== activeIndex) select(next);
    },
  }));

  if (!descriptor) return null;

  const stops = options.map((option, index) => {
    const clock = clockAngle(index, options.length);
    const radians = (clock * Math.PI) / 180;
    return {
      option,
      clock,
      x: 50 + Math.cos(radians) * RADIUS,
      y: 50 + Math.sin(radians) * RADIUS,
    };
  });
  const angle = (stops[activeIndex]?.clock ?? 180) - 270;
  const activeLabel = options[activeIndex]?.label ?? "";

  return (
    <div
      className="device-dial"
      role="group"
      aria-label="Reasoning"
      style={{ "--dial-angle": `${angle}deg` } as CSSProperties}
    >
      {stops.map((stop, index) => (
        <button
          key={stop.option.id}
          type="button"
          disabled={disabled}
          aria-pressed={index === activeIndex}
          aria-label={`Reasoning ${stop.option.label}`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => select(index)}
          className={cn(
            "device-dial__setting",
            stop.x >= 50 && "device-dial__setting--right",
            index === activeIndex && "device-dial__setting--active",
          )}
          style={{ "--sx": `${stop.x}%`, "--sy": `${stop.y}%` } as CSSProperties}
        >
          <span>{shortLabel(stop.option)}</span>
          <span className="device-dial__light" aria-hidden="true" />
        </button>
      ))}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="device-dial__knob"
              aria-disabled={disabled || undefined}
              data-composer-shortcut="composer.effort"
              aria-label={`Reasoning ${activeLabel}; turn up`}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => select((activeIndex + 1) % options.length)}
            />
          }
        />
        <TooltipPopup side="top">
          {controls.ultrathinkInBodyText
            ? 'Your prompt contains "ultrathink". Remove it to change reasoning.'
            : `Reasoning ${activeLabel} · ⌘↑ ⌘↓`}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});
