import type { AgentRole, ProjectIconColor } from "@t3tools/contracts";
import {
  BrushCleaningIcon,
  CompassIcon,
  FileCheckIcon,
  GlobeIcon,
  HammerIcon,
  LightbulbIcon,
  type LucideIcon,
  MapIcon,
  PaletteIcon,
  ScanEyeIcon,
  SearchIcon,
  TicketCheckIcon,
} from "lucide-react";

import { TintChip, type TintChipProps } from "./TintChip";

/** How each subagent role is named and drawn wherever it appears. */
export const AGENT_ROLE_PRESENTATION: Record<
  AgentRole,
  { readonly label: string; readonly icon: LucideIcon; readonly tint: ProjectIconColor }
> = {
  "chore-worker": { label: "Chore worker", icon: BrushCleaningIcon, tint: "gray" },
  "implementation-worker": { label: "Implementer", icon: HammerIcon, tint: "blue" },
  "ui-worker": { label: "UI worker", icon: PaletteIcon, tint: "pink" },
  browser: { label: "Browser", icon: GlobeIcon, tint: "cyan" },
  "ui-verifier": { label: "UI verifier", icon: ScanEyeIcon, tint: "violet" },
  advisor: { label: "Advisor", icon: LightbulbIcon, tint: "amber" },
  "ticket-reviewer": { label: "Ticket reviewer", icon: TicketCheckIcon, tint: "emerald" },
  "spec-reviewer": { label: "Spec reviewer", icon: FileCheckIcon, tint: "teal" },
  researcher: { label: "Researcher", icon: SearchIcon, tint: "orange" },
  scout: { label: "Scout", icon: MapIcon, tint: "lime" },
  lead: { label: "Spec lead", icon: CompassIcon, tint: "indigo" },
};

/** A subagent role as a chip with its icon and colour. */
export function AgentRoleChip({
  role,
  ...props
}: Omit<TintChipProps, "tint" | "icon" | "label"> & { role: AgentRole }) {
  const { label, icon: Icon, tint } = AGENT_ROLE_PRESENTATION[role];
  return (
    <TintChip
      data-slot="agent-role-chip"
      tint={tint}
      icon={<Icon aria-hidden className="size-3 shrink-0" />}
      label={label}
      {...props}
    />
  );
}
