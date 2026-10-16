import type { EnvironmentId, OrchestrationV2ThreadWorkflow, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { PlusIcon } from "lucide-react";

import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { TintChip } from "../TintChip";
import { THREAD_WORKFLOW_ICONS, ThreadWorkflowChip } from "../ThreadWorkflowChip";
import {
  SELECTABLE_THREAD_WORKFLOW_KINDS,
  THREAD_WORKFLOW_LABELS,
  type SelectableThreadWorkflowKind,
  visibleThreadWorkflow,
  withWorkflowKind,
  withWorkflowUnattended,
} from "@t3tools/client-runtime/thread-workflow";

/**
 * The header's workflow chip, opening a menu to change, mark unattended or clear it. With
 * no workflow set it shows a quiet "Set workflow" chip, so a cleared workflow can be set
 * again. Read-only viewers see the chip without the menu.
 */
export function ThreadWorkflowMenu(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  workflow: OrchestrationV2ThreadWorkflow | null | undefined;
  canEdit: boolean;
}) {
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const shown = visibleThreadWorkflow(props.workflow);
  if (!shown && !props.canEdit) return null;

  const save = (workflow: OrchestrationV2ThreadWorkflow | null) => {
    void updateThreadMetadata({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, workflow },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to update workflow",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    });
  };

  if (!props.canEdit && shown) {
    return <ThreadWorkflowChip kind={shown.kind} unattended={shown.unattended} />;
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          shown ? (
            <ThreadWorkflowChip
              kind={shown.kind}
              unattended={shown.unattended}
              render={<button type="button" />}
            />
          ) : (
            <TintChip
              data-slot="thread-workflow-chip"
              tint="gray"
              icon={<PlusIcon aria-hidden className="size-3 shrink-0" />}
              label="Set workflow"
              className="opacity-70 hover:opacity-100"
              render={<button type="button" aria-label="Set workflow" />}
            />
          )
        }
      />
      <MenuPopup align="start">
        <MenuGroup>
          <MenuRadioGroup
            value={shown?.kind ?? ""}
            onValueChange={(value) =>
              save(withWorkflowKind(props.workflow, value as SelectableThreadWorkflowKind))
            }
          >
            {SELECTABLE_THREAD_WORKFLOW_KINDS.map((kind) => {
              const Icon = THREAD_WORKFLOW_ICONS[kind];
              return (
                <MenuRadioItem key={kind} value={kind}>
                  <span className="flex items-center gap-2">
                    <Icon aria-hidden />
                    {THREAD_WORKFLOW_LABELS[kind]}
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuGroup>
        {shown ? (
          <>
            <MenuSeparator />
            <MenuCheckboxItem
              checked={shown.unattended}
              onCheckedChange={(checked) => save(withWorkflowUnattended(shown, checked))}
            >
              Unattended
            </MenuCheckboxItem>
            <MenuSeparator />
            <MenuItem onClick={() => save(null)}>Clear workflow</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
