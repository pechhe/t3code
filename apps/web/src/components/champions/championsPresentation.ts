import { CHAMPION_STATUS_LABELS, type ChampionStatus } from "@t3tools/client-runtime/champions";
import type { ChampionFinding } from "@t3tools/contracts";

type BadgeVariant = "warning" | "info" | "success" | "outline";

const STATUS_VARIANTS: Record<ChampionStatus, BadgeVariant> = {
  review: "warning",
  attention: "warning",
  "setting-up": "info",
  checking: "info",
  working: "info",
  "off-target": "warning",
  unknown: "outline",
  stale: "warning",
  unmeasured: "outline",
  healthy: "success",
  paused: "outline",
  retired: "outline",
};

export const statusBadge = (status: ChampionStatus) => ({
  label: CHAMPION_STATUS_LABELS[status],
  variant: STATUS_VARIANTS[status],
});

export const FINDING_VARIANTS: Record<ChampionFinding["status"], BadgeVariant> = {
  open: "warning",
  working: "info",
  handed_back: "info",
  delivered: "info",
  verified: "success",
  inconclusive: "outline",
  dismissed: "outline",
};

export const HEALTH_DOTS: Record<ChampionStatus, string> = {
  review: "bg-warning",
  attention: "bg-warning",
  "setting-up": "bg-info",
  checking: "bg-info",
  working: "bg-info",
  unmeasured: "bg-muted-foreground/50",
  stale: "bg-warning",
  unknown: "bg-muted-foreground/50",
  "off-target": "bg-warning",
  healthy: "bg-success",
  paused: "bg-muted-foreground/50",
  retired: "bg-muted-foreground/30",
};
