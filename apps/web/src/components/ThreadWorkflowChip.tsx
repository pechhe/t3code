import {
  CrownIcon,
  type LucideIcon,
  MessageCircleIcon,
  PencilRulerIcon,
  UserIcon,
} from "lucide-react";

import { TintChip, type TintChipProps } from "./TintChip";
import {
  THREAD_WORKFLOW_LABELS,
  THREAD_WORKFLOW_TINTS,
  type SelectableThreadWorkflowKind,
} from "@t3tools/client-runtime/thread-workflow";

/** Each thread workflow's icon wherever web draws it. */
export const THREAD_WORKFLOW_ICONS: Record<SelectableThreadWorkflowKind, LucideIcon> = {
  lead: CrownIcon,
  shape: PencilRulerIcon,
  solo: UserIcon,
  chat: MessageCircleIcon,
};

export function ThreadWorkflowChip({
  kind,
  ...props
}: Omit<TintChipProps, "tint" | "icon" | "label"> & {
  kind: SelectableThreadWorkflowKind;
}) {
  const Icon = THREAD_WORKFLOW_ICONS[kind];
  return (
    <TintChip
      data-slot="thread-workflow-chip"
      tint={THREAD_WORKFLOW_TINTS[kind]}
      icon={<Icon aria-hidden className="size-3 shrink-0" />}
      label={THREAD_WORKFLOW_LABELS[kind]}
      aria-label={THREAD_WORKFLOW_LABELS[kind]}
      {...props}
    />
  );
}
