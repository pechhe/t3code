import {
  forgeItemLabel,
  forgeItemNumberHint,
} from "@t3tools/client-runtime/state/forge-work-items";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** An item's ref such as `YS-12`, or `#<number>`; a ref carries the canonical number in a tooltip. */
export function ForgeItemLabel(props: {
  item: { readonly number: number; readonly ref?: string | null | undefined };
  className?: string;
}) {
  const label = forgeItemLabel(props.item);
  const hint = forgeItemNumberHint(props.item);
  if (hint === undefined) return <span className={props.className}>{label}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={props.className} />}>{label}</TooltipTrigger>
      <TooltipPopup side="top">{hint}</TooltipPopup>
    </Tooltip>
  );
}
