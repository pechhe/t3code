import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { MoreHorizontalIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";

import { useSelectedWorkspaceStore } from "../selectedWorkspaceStore";
import { useProject } from "../state/entities";
import { orchestrationEnvironment } from "../state/orchestration";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import {
  resolveWorkspaceChipDetail,
  type WorkspaceChip as WorkspaceChipModel,
} from "@t3tools/client-runtime/thread-workspaces";
import { cn } from "~/lib/utils";
import { ProjectFavicon } from "./ProjectFavicon";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * One row per workspace the thread holds: the primary one and each attachment, with the
 * project, its base or branch and the uncommitted edits. Selecting a row points the git
 * panel, diff, terminal and Land at that workspace.
 */
export function WorkspaceAttachmentChips(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  chips: ReadonlyArray<WorkspaceChipModel>;
}) {
  return (
    <ul className="flex flex-col" aria-label="Workspaces">
      {props.chips.map((chip) => (
        <WorkspaceChipRow
          key={chip.workspacePath ?? "primary"}
          environmentId={props.environmentId}
          threadId={props.threadId}
          chip={chip}
        />
      ))}
    </ul>
  );
}

function WorkspaceChipRow(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  chip: WorkspaceChipModel;
}) {
  const { chip } = props;
  const project = useProject(scopeProjectRef(props.environmentId, chip.projectId));
  const { data: status } = useEnvironmentQuery(
    chip.statusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId: props.environmentId,
          input: { cwd: chip.statusCwd },
        }),
  );
  const detachWorkspace = useAtomCommand(orchestrationEnvironment.detachWorkspace, {
    reportFailure: false,
  });
  const canDetach = useAtomValue(
    orchestrationEnvironment.detachWorkspace.permissionAtom(props.environmentId),
  );
  const [detaching, setDetaching] = useState(false);
  const select = useSelectedWorkspaceStore((store) => store.select);
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const detail = resolveWorkspaceChipDetail({
    released: chip.released,
    branch: chip.branch,
    status: status ?? null,
  });

  const detach = async () => {
    if (chip.workspacePath === null || detaching) return;
    setDetaching(true);
    const result = await detachWorkspace({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, workspacePath: chip.workspacePath },
    });
    setDetaching(false);
    if (result._tag === "Success") return;
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not detach workspace",
        description: error instanceof Error ? error.message : "An error occurred.",
        data: { threadRef },
      }),
    );
  };

  const content = (
    <>
      {project ? (
        <ProjectFavicon project={project} className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      ) : null}
      <span
        className={cn(
          THREAD_DETAILS_PANEL_LABEL_CLASS,
          "min-w-0 truncate",
          chip.released && "text-muted-foreground/70",
        )}
      >
        {project?.title ?? "Workspace"}
      </span>
      {detail.label ? (
        <span className="min-w-0 truncate text-xs text-muted-foreground/70">{detail.label}</span>
      ) : null}
      {detail.editedFileCount > 0 ? (
        <span className="shrink-0 text-xs text-muted-foreground/70">
          {detail.editedFileCount} {detail.editedFileCount === 1 ? "file" : "files"}
        </span>
      ) : null}
    </>
  );
  const rowButton = (
    <ThreadDetailsControl
      size="sm"
      variant="ghost"
      part={chip.detachable ? "primary" : "row"}
      aria-pressed={chip.selected}
      disabled={chip.released}
      className={cn(chip.selected && "bg-black/[0.035] dark:bg-white/[0.08]")}
      onClick={() => select(threadRef, chip.workspacePath)}
    >
      {content}
    </ThreadDetailsControl>
  );
  const row = (
    <Tooltip>
      <TooltipTrigger render={rowButton} />
      <TooltipPopup>{chip.workspacePath ?? "Primary workspace"}</TooltipPopup>
    </Tooltip>
  );

  return (
    <li className="flex h-8 items-center rounded-lg" data-workspace-chip={chip.workspacePath}>
      {chip.detachable ? (
        <div className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}>
          {row}
          <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
          <Menu>
            <MenuTrigger
              render={
                <ThreadDetailsControl
                  size="sm"
                  variant="ghost"
                  part="secondary"
                  aria-label="Workspace actions"
                />
              }
            >
              <MoreHorizontalIcon className="size-3" />
            </MenuTrigger>
            <MenuPopup align="end" side="bottom">
              <MenuItem disabled={!canDetach || detaching} onClick={() => void detach()}>
                <UnlinkIcon className="size-3" />
                {detaching ? "Detaching…" : "Detach"}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      ) : (
        row
      )}
    </li>
  );
}
