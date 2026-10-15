import type { EnvironmentId } from "@t3tools/contracts";

import { playRotary } from "~/lib/interfaceSounds";
import { cn } from "~/lib/utils";
import type { EnvironmentOption } from "../../BranchToolbar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

interface DeviceEnvironmentSwitchProps {
  /** Exactly two machines: the upper position, then the lower one. */
  environments: readonly [EnvironmentOption, EnvironmentOption];
  environmentId: EnvironmentId;
  /** A started thread stays on its machine; the switch then only shows where it runs. */
  locked: boolean;
  onChange: (environmentId: EnvironmentId) => void;
}

function switchLabel(environment: EnvironmentOption): string {
  return environment.isPrimary ? "Local" : environment.label;
}

/**
 * The two-position lever choosing which machine a new thread runs on. It
 * replaces the strip's "Run on" picker when the project lives on exactly two
 * machines.
 */
export function DeviceEnvironmentSwitch({
  environments,
  environmentId,
  locked,
  onChange,
}: DeviceEnvironmentSwitchProps) {
  const [upper, lower] = environments;
  const active = environmentId === lower.environmentId ? lower : upper;
  const other = active === upper ? lower : upper;
  const atLower = active === lower;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            role="switch"
            aria-checked={atLower}
            aria-disabled={locked || undefined}
            aria-label={`Run on ${active.label}`}
            data-composer-shortcut="composer.cycleHost"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (locked) return;
              playRotary();
              onChange(other.environmentId);
            }}
            className={cn("device-switch", atLower && "device-switch--lower")}
          >
            <span className="device-switch__label device-switch__label--upper">
              {switchLabel(upper)}
            </span>
            <span className="device-switch__track" aria-hidden="true">
              <span className="device-switch__thumb" />
            </span>
            <span className="device-switch__label device-switch__label--lower">
              {switchLabel(lower)}
            </span>
          </button>
        }
      />
      <TooltipPopup side="top">
        {locked
          ? `Runs on ${active.label}. A started thread stays on its machine.`
          : `Runs on ${active.label}. Click to switch to ${other.label}.`}
      </TooltipPopup>
    </Tooltip>
  );
}
