import type { DelegationStance } from "@t3tools/contracts";
import { BlendIcon, HammerIcon, SplitIcon } from "lucide-react";

export const STANCE_ICON: Readonly<Record<DelegationStance, typeof HammerIcon>> = {
  orchestrate: SplitIcon,
  flexible: BlendIcon,
  implement: HammerIcon,
};
