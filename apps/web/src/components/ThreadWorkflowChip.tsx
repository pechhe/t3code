import {
  CrownIcon,
  type LucideIcon,
  MessageCircleIcon,
  MoonIcon,
  PencilRulerIcon,
  UserIcon,
} from "lucide-react";

import { TintChip, type TintChipProps } from "./TintChip";
import {
  THREAD_WORKFLOW_LABELS,
  THREAD_WORKFLOW_TINTS,
  type SelectableThreadWorkflowKind,
  threadWorkflowChipLabel,
} from "@t3tools/client-runtime/thread-workflow";

/** Each thread workflow's icon wherever web draws it. */
export const THREAD_WORKFLOW_ICONS: Record<SelectableThreadWorkflowKind, LucideIcon> = {
  lead: CrownIcon,
  shape: PencilRulerIcon,
  solo: UserIcon,
  chat: MessageCircleIcon,
};

/**
 * A thread's governing workflow as a chip. An unattended thread carries a static moon
 * marker after the name; nothing animates.
 */
export function ThreadWorkflowChip({
  kind,
  unattended,
  ...props
}: Omit<TintChipProps, "tint" | "icon" | "label"> & {
  kind: SelectableThreadWorkflowKind;
  unattended: boolean;
}) {
  const Icon = THREAD_WORKFLOW_ICONS[kind];
  return (
    <TintChip
      data-slot="thread-workflow-chip"
      data-unattended={unattended ? "" : undefined}
      tint={THREAD_WORKFLOW_TINTS[kind]}
      icon={<Icon aria-hidden className="size-3 shrink-0" />}
      label={THREAD_WORKFLOW_LABELS[kind]}
      aria-label={threadWorkflowChipLabel({ kind, unattended })}
      {...props}
    >
      {unattended ? <MoonIcon aria-hidden className="size-2.5 shrink-0 opacity-80" /> : null}
    </TintChip>
  );
}
