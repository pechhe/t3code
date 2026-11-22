import type { DelegationStance } from "@t3tools/contracts";
import { HammerIcon, SplitIcon } from "lucide-react";

export const STANCE_ICON: Readonly<Record<DelegationStance, typeof HammerIcon>> = {
  orchestrate: SplitIcon,
  implement: HammerIcon,
};
