import type { ReactNode } from "react";

/**
 * A device control with its name engraved beneath it. The caption hangs below without
 * taking width, so a changing caption never shifts the control. `lit` marks an action
 * other than the control's everyday one; `detail` is a smaller second line.
 */
export function DeviceUnit(props: {
  caption: string;
  detail?: string;
  lit?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="device-unit">
      {props.children}
      <span className="device-unit__caption" data-lit={props.lit || undefined} aria-hidden="true">
        {props.caption}
        {props.detail === undefined ? null : (
          <span className="device-unit__detail">{props.detail}</span>
        )}
      </span>
    </span>
  );
}
