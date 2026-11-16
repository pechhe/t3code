import type { DelegationStance } from "@t3tools/contracts";
import { useRef, type KeyboardEvent } from "react";

import { playRotary } from "~/lib/interfaceSounds";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  DELEGATION_STANCE_OPTIONS,
  type DelegationStanceOption,
  getDelegationStanceOption,
  stepDelegationStance,
} from "../stance.logic";
import { STANCE_ICON } from "../stanceIcons";
import { DeviceLeverTrack } from "./DeviceLever";

interface DeviceStanceSwitchProps {
  stance: DelegationStance;
  disabled?: boolean;
  onChange: (stance: DelegationStance) => void;
}

/**
 * Three-position delegation stance lever, a sibling of the machine lever. Each stop is
 * marked by an icon alone, whose tooltip names the stance and says what it does. Clicking
 * the track cycles positions; an icon or the arrow keys pick a stance directly.
 */
export function DeviceStanceSwitch({
  stance,
  disabled = false,
  onChange,
}: DeviceStanceSwitchProps) {
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeOption = getDelegationStanceOption(stance);
  const explain = (option: DelegationStanceOption) => (
    <>
      <span className="device-stance__tip-name">{option.label}</span>
      <span>{option.tooltip}</span>
    </>
  );

  const select = (next: DelegationStance, options?: { focus?: boolean }) => {
    if (disabled || next === stance) return;
    playRotary();
    onChange(next);
    if (options?.focus) {
      const nextIndex = DELEGATION_STANCE_OPTIONS.findIndex((option) => option.stance === next);
      if (nextIndex >= 0) radioRefs.current[nextIndex]?.focus();
    }
  };

  const handleRadioKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled) return;
    let next: DelegationStance | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      next = stepDelegationStance(DELEGATION_STANCE_OPTIONS[index]!.stance, 1);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      next = stepDelegationStance(DELEGATION_STANCE_OPTIONS[index]!.stance, -1);
    } else if (event.key === "Home") {
      next = DELEGATION_STANCE_OPTIONS[0].stance;
    } else if (event.key === "End") {
      next = DELEGATION_STANCE_OPTIONS[2].stance;
    }
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    select(next, { focus: true });
  };

  return (
    <div
      role="radiogroup"
      aria-label="Delegation stance"
      aria-disabled={disabled || undefined}
      data-stance={stance}
      className="device-stance"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-hidden="true"
              className="device-stance__track-hit"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => select(stepDelegationStance(stance, 1))}
            />
          }
        >
          <DeviceLeverTrack
            trackClassName="device-stance__track"
            thumbClassName="device-stance__thumb"
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{explain(activeOption)}</TooltipPopup>
      </Tooltip>
      <div className="device-stance__names">
        {DELEGATION_STANCE_OPTIONS.map((option, index) => {
          const checked = option.stance === stance;
          const OptionIcon = STANCE_ICON[option.stance];
          return (
            <Tooltip key={option.stance}>
              <TooltipTrigger
                render={
                  <button
                    ref={(node) => {
                      radioRefs.current[index] = node;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={option.label}
                    aria-description={option.tooltip}
                    tabIndex={checked ? 0 : -1}
                    disabled={disabled}
                    data-stance-option={option.stance}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => select(option.stance)}
                    onKeyDown={(event) => handleRadioKeyDown(event, index)}
                  />
                }
              >
                <OptionIcon aria-hidden="true" className="device-stance__icon" />
              </TooltipTrigger>
              <TooltipPopup side="top">{explain(option)}</TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
