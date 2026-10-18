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
 * A thread's governing workflow as a chip. An unattended thread adds a moon segment, set off
 * by a divider in the chip's tint, so it reads at a glance in a long list; nothing animates.
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
      {unattended ? (
        <span
          aria-hidden
          className="ms-0.5 flex h-full shrink-0 items-center border-s border-(--tint-chip-border) ps-1"
        >
          <MoonIcon className="size-3 shrink-0" />
        </span>
      ) : null}
    </TintChip>
  );
}
