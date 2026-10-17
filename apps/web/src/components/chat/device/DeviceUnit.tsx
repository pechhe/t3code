import type { ReactNode } from "react";

/**
 * A device control with its name engraved beneath it. The caption hangs below without
 * taking width, so a changing caption never shifts the control. `lit` marks an action
 * other than the control's everyday one.
 */
export function DeviceUnit(props: { caption: string; lit?: boolean; children: ReactNode }) {
  return (
    <span className="device-unit">
      {props.children}
      <span className="device-unit__caption" data-lit={props.lit || undefined} aria-hidden="true">
        {props.caption}
      </span>
    </span>
  );
}
