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
  ultra: "ULTRA",
  ultracode: "ULTRACODE",
  ultrathink: "ULTRATHINK",
};

function shortLabel(option: EffortOption): string {
  return SHORT_LABELS[option.id.toLowerCase()] ?? option.label.toUpperCase();
}

// Settings sit a detent apart, clockwise, on an arc centred at half past one; a
// full set spans nine o'clock (180°) to half past four (405°).
const DETENT_DEGREES = 37.5;
const ARC_DEGREES = 225;
const ARC_CENTRE = 180 + ARC_DEGREES / 2;

function clockAngle(index: number, count: number): number {
  if (count <= 1) return ARC_CENTRE;
  const step = Math.min(DETENT_DEGREES, ARC_DEGREES / (count - 1));
  return ARC_CENTRE - (step * (count - 1)) / 2 + index * step;
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
    return { option, clock, ux: Math.cos(radians), uy: Math.sin(radians) };
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
            stop.ux > -0.01 && "device-dial__setting--right",
            index === activeIndex && "device-dial__setting--active",
          )}
          style={{ "--ux": stop.ux, "--uy": stop.uy } as CSSProperties}
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
