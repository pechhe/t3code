import { forwardRef, useImperativeHandle, type CSSProperties } from "react";
import type { ProviderOptionDescriptor } from "@t3tools/contracts";

import { playRotary } from "~/lib/interfaceSounds";
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
  medium: "MEDIUM",
  xhigh: "X-HIGH",
};

function shortLabel(option: EffortOption): string {
  return SHORT_LABELS[option.id.toLowerCase()] ?? option.label.toUpperCase();
}

/** Each setting's lamp colour, cool to hot as effort climbs; ultra modes stand apart. */
const EFFORT_TONES: Readonly<Record<string, string>> = {
  none: "off",
  off: "off",
  minimal: "off",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "ultra",
  ultrathink: "ultra",
  ultracode: "ultracode",
};

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
 * The reasoning knob: one tick per effort the selected model offers, and a readout
 * naming the chosen one in its colour. Clicking a tick selects it, clicking the knob
 * turns it up a stop (wrapping at the top), and ⌘↑/⌘↓ step it through the handle.
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

  const angles = options.map((_, index) => clockAngle(index, options.length));
  const angle = (angles[activeIndex] ?? 180) - 270;
  const active = options[activeIndex];
  const activeLabel = active?.label ?? "";
  const tone = active ? (EFFORT_TONES[active.id.toLowerCase()] ?? "medium") : "medium";

  return (
    <div
      className="device-dial"
      role="group"
      aria-label="Reasoning"
      data-tone={tone}
      style={{ "--dial-angle": `${angle}deg` } as CSSProperties}
    >
      <div className="device-dial__face">
        {options.map((option, index) => (
          <Tooltip key={option.id}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed={index === activeIndex}
                  aria-label={`Reasoning ${option.label}`}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => select(index)}
                  className="device-dial__tick"
                  style={{ "--tick-angle": `${angles[index]}deg` } as CSSProperties}
                />
              }
            />
            <TooltipPopup side="top">{option.label}</TooltipPopup>
          </Tooltip>
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
      <div className="device-dial__readout" aria-hidden="true">
        <span className="device-dial__caption">Reasoning</span>
        <span className="device-dial__screen">
          {tone === "ultracode" ? "✦ " : ""}
          {active ? shortLabel(active) : ""}
        </span>
        <span className="device-dial__caption">
          {activeIndex + 1} / {options.length}
        </span>
      </div>
    </div>
  );
});
