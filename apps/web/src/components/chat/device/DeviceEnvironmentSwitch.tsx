import type { EnvironmentId } from "@t3tools/contracts";
import { EllipsisIcon, HandIcon, LockIcon, MinusIcon, SparkleIcon } from "lucide-react";

import { playRotary } from "~/lib/interfaceSounds";
import { cn } from "~/lib/utils";
import type { EnvironmentOption } from "../../BranchToolbar.logic";
import { EnvironmentMachineIcon } from "../../EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { DeviceLeverTrack } from "./DeviceLever";

interface DeviceEnvironmentSwitchProps {
  /** Exactly two machines: the upper position, then the lower one. */
  environments: readonly [EnvironmentOption, EnvironmentOption];
  environmentId: EnvironmentId;
  /** A started thread stays on its machine; the switch then only shows where it runs. */
  locked: boolean;
  /**
   * Live load balancing owns the lever's position: "auto" when it picked the
   * machine the knob rests on, "override" when the user moved it off the pick.
   * Undefined keeps the plain two-position lever, with no balancing in play.
   */
  balanceState?: "auto" | "override" | "checking" | "unavailable" | undefined;
  /** What load balancing would have picked, shown only on an override. */
  balancedEnvironmentLabel?: string | undefined;
  onChange: (environmentId: EnvironmentId) => void;
  /** Offered on a locked switch whose thread can move: asks to move it to the other machine. */
  onMove?: (() => void) | undefined;
}

function SwitchLabel({
  environment,
  position,
  named,
}: {
  environment: EnvironmentOption;
  position: "upper" | "lower";
  named: boolean;
}) {
  return (
    <span className={`device-switch__label device-switch__label--${position}`}>
      <EnvironmentMachineIcon kind={environment.machine} className="device-switch__icon" />
      {named ? (
        <span className="device-switch__name">
          {environment.isPrimary ? "Local" : environment.label}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The two-position lever choosing which machine a new thread runs on. It
 * replaces the strip's "Run on" picker when the project lives on exactly two
 * machines; the illuminated symbol distinguishes the balancer's pick from a
 * manual override without changing the machine labels' meaning.
 */
export function DeviceEnvironmentSwitch({
  environments,
  environmentId,
  locked,
  balanceState,
  balancedEnvironmentLabel,
  onChange,
  onMove,
}: DeviceEnvironmentSwitchProps) {
  const [upper, lower] = environments;
  const active = environmentId === lower.environmentId ? lower : upper;
  const other = active === upper ? lower : upper;
  const atLower = active === lower;
  const movable = locked && onMove !== undefined;
  // Two machines of one kind share an icon, so only then do the names tell them apart.
  const named = upper.machine === lower.machine;
  const description = movable
    ? `Runs on ${active.label}. Click to move this thread to ${other.label}.`
    : locked
      ? `Runs on ${active.label}. A started thread stays on its machine.`
      : balanceState === "auto"
        ? `Auto balance recommends ${active.label}. Click to choose ${other.label} manually.`
        : balanceState === "override"
          ? balancedEnvironmentLabel
            ? `Manual override. Runs on ${active.label}; auto balance recommends ${balancedEnvironmentLabel}. Click to return to Auto.`
            : `Manual override. Runs on ${active.label}. Click to switch to ${other.label}.`
          : balanceState === "checking"
            ? "Auto balance is checking machines…"
            : balanceState === "unavailable"
              ? `Auto balance unavailable. Click to choose ${other.label}.`
              : `Runs on ${active.label}. Click to switch to ${other.label}.`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            role="switch"
            aria-checked={atLower}
            aria-disabled={(locked && !movable) || undefined}
            aria-label={`Run on ${active.label}`}
            aria-description={description}
            data-composer-shortcut="composer.cycleHost"
            data-device-switch-balance={balanceState}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (movable) return onMove();
              if (locked) return;
              playRotary();
              onChange(other.environmentId);
            }}
            className={cn(
              "device-switch",
              atLower && "device-switch--lower",
              !named && "device-switch--icons",
            )}
          >
            <SwitchLabel environment={upper} position="upper" named={named} />
            <DeviceLeverTrack
              trackClassName="device-switch__track"
              thumbClassName="device-switch__thumb"
            >
              {locked ? (
                <LockIcon className="device-switch__lock" />
              ) : balanceState ? (
                <span className={`device-switch__badge device-switch__badge--${balanceState}`}>
                  {balanceState === "auto" ? (
                    <SparkleIcon />
                  ) : balanceState === "override" ? (
                    <HandIcon />
                  ) : balanceState === "checking" ? (
                    <EllipsisIcon />
                  ) : (
                    <MinusIcon />
                  )}
                </span>
              ) : null}
            </DeviceLeverTrack>
            <SwitchLabel environment={lower} position="lower" named={named} />
          </button>
        }
      />
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
}
