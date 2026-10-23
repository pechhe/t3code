import type { EnvironmentId } from "@t3tools/contracts";
import { LockIcon } from "lucide-react";

import { playRotary } from "~/lib/interfaceSounds";
import { cn } from "~/lib/utils";
import type { EnvironmentOption } from "../../BranchToolbar.logic";
import { EnvironmentMachineIcon } from "../../EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

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
  balanceState?: "auto" | "override" | undefined;
  /** What load balancing would have picked, shown only on an override. */
  balancedEnvironmentLabel?: string | undefined;
  /** Auto mode, still choosing a machine from live load. */
  checkingMachines?: boolean | undefined;
  onChange: (environmentId: EnvironmentId) => void;
}

function SwitchLabel({
  environment,
  position,
}: {
  environment: EnvironmentOption;
  position: "upper" | "lower";
}) {
  return (
    <span className={`device-switch__label device-switch__label--${position}`}>
      <EnvironmentMachineIcon kind={environment.machine} className="device-switch__icon" />
      <span className="device-switch__name">
        {environment.isPrimary ? "Local" : environment.label}
      </span>
    </span>
  );
}

/**
 * The two-position lever choosing which machine a new thread runs on. It
 * replaces the strip's "Run on" picker when the project lives on exactly two
 * machines; with load balancing, the stamped knob shows whose choice sits
 * where — A for the balancer's pick, O for an overridden one.
 */
export function DeviceEnvironmentSwitch({
  environments,
  environmentId,
  locked,
  balanceState,
  balancedEnvironmentLabel,
  checkingMachines,
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
            data-device-switch-balance={balanceState}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (locked) return;
              playRotary();
              onChange(other.environmentId);
            }}
            className={cn("device-switch", atLower && "device-switch--lower")}
          >
            <SwitchLabel environment={upper} position="upper" />
            <span className="device-switch__track" aria-hidden="true">
              <span className="device-switch__thumb">
                {locked ? (
                  <LockIcon className="device-switch__lock" />
                ) : balanceState ? (
                  <span
                    className={cn(
                      "device-switch__badge",
                      balanceState === "auto"
                        ? "device-switch__badge--auto"
                        : "device-switch__badge--override",
                    )}
                  >
                    {balanceState === "auto" ? "A" : "O"}
                  </span>
                ) : null}
              </span>
            </span>
            <SwitchLabel environment={lower} position="lower" />
          </button>
        }
      />
      <TooltipPopup side="top">
        {locked
          ? `Runs on ${active.label}. A started thread stays on its machine.`
          : balanceState === "auto"
            ? checkingMachines
              ? `Auto load balanced. Picking the least loaded machine…`
              : `Auto load balanced. Runs on ${active.label}; click to switch to ${other.label}.`
            : balanceState === "override"
              ? balancedEnvironmentLabel === active.label
                ? `Override. Your pick, which is also the machine auto load would choose.`
                : `Override. Auto load would run on ${balancedEnvironmentLabel ?? "another machine"}.`
              : `Runs on ${active.label}. Click to switch to ${other.label}.`}
      </TooltipPopup>
    </Tooltip>
  );
}
