import { MoonIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DeviceUnit } from "./device/DeviceUnit";

/** The machined composer's Away key: latched in while the thread runs unattended. */
export function ComposerAwayKey(props: {
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const tooltip = props.on
    ? "Away: the agent keeps working and answers its own questions. Click when you're back."
    : "Going away? The agent keeps working and answers its own questions";
  return (
    <DeviceUnit caption="Away" night={props.on}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="device-key"
              aria-pressed={props.on}
              aria-label={props.on ? "Away on" : "Away off"}
              disabled={props.disabled}
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onToggle}
            />
          }
        >
          <MoonIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
    </DeviceUnit>
  );
}
