import {
  buildItemLabel,
  buildItemNumberHint,
} from "@t3tools/client-runtime/state/build-work-items";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** An item's ref such as `YS-12`, or `#<number>`; a ref carries the canonical number in a tooltip. */
export function BuildItemLabel(props: {
  item: { readonly number: number; readonly ref?: string | null | undefined };
  className?: string;
}) {
  const label = buildItemLabel(props.item);
  const hint = buildItemNumberHint(props.item);
  if (hint === undefined) return <span className={props.className}>{label}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={props.className} />}>{label}</TooltipTrigger>
      <TooltipPopup side="top">{hint}</TooltipPopup>
    </Tooltip>
  );
}
