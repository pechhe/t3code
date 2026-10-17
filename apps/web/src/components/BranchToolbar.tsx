import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { readLocalApi } from "../localApi";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  ScaleIcon,
  type LucideIcon,
} from "lucide-react";
import { type MouseEvent as ReactMouseEvent, memo, useState } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useProject, useThreadShell, useThreadShellsForProjectRefs } from "../state/entities";
import {
  resolveSlipJayBaseLabel,
  resolveSlipJayLandingLabel,
  resolveSlipJayWorkspaceLabel,
  type SlipJayCheckoutStatus,
} from "@t3tools/client-runtime/slipjay-checkout";
import {
  type EnvMode,
  type EnvironmentOption,
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  resolvePreviousWorktreeLabel,
  resolvePreviousWorktreeSeed,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { SlipJayLandingLogDialog } from "./SlipJayLandingLogDialog";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { MiddleTruncate } from "./ui/middle-truncate";
import { cn } from "~/lib/utils";

interface BranchToolbarProps {
  panelSection?: "all" | "workspace" | "branch";
  forceNewWorktree?: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** Set in a SlipJay project, whose workspace and base replace the Git controls. */
  slipJayStatus?: SlipJayCheckoutStatus | null;
  draftId?: DraftId;
  onEnvModeChange: (mode: EnvMode) => void;
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
}

function showWorkspaceContextMenu(event: ReactMouseEvent, workspacePath: string) {
  const api = readLocalApi();
  if (!api) return;
  event.preventDefault();
  event.stopPropagation();
  void api.contextMenu
    .show([{ id: "copy-path", label: "Copy full path", icon: "copy" }], {
      x: event.clientX,
      y: event.clientY,
    })
    .then((action) => {
      if (action !== "copy-path") return;
      void writeTextToClipboard(workspacePath, "workspace path").then(
        (didCopy) => {
          if (didCopy) {
            toastManager.add({
              type: "success",
              title: "Path copied",
              description: workspacePath,
            });
          }
        },
        (error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to copy path",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        },
      );
    });
}

/**
 * A details panel row: SlipJay assigns the workspace and its base, so only a
 * landing's row acts, opening its log.
 */
function SlipJayContextRow({
  icon: Icon,
  label,
  tooltip,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  tooltip: string;
  onClick?: () => void;
}) {
  const rowClassName = cn(
    "inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6",
    THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
    onClick && "cursor-pointer rounded-md hover:text-foreground",
  );
  const content = (
    <>
      <Icon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      <ComposerContextLabel displayMode="panel">{label}</ComposerContextLabel>
    </>
  );
  const row = onClick ? (
    <button type="button" className={rowClassName} onClick={onClick}>
      {content}
    </button>
  ) : (
    <span className={rowClassName}>{content}</span>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

interface RunContextSelectorProps {
  workspaceRoot?: string;
  forceNewWorktree: boolean;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  envModeLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[] | undefined;
  showEnvironmentPicker: boolean;
  showEnvironmentIndicator: boolean;
  onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel: string | null;
  previousWorktreeBranch: string | null;
  onUsePreviousWorktree: () => void;
}

const RunContextSelector = memo(function RunContextSelector({
  workspaceRoot,
  forceNewWorktree,
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  envModeLocked,
  environmentId,
  availableEnvironments,
  showEnvironmentPicker,
  showEnvironmentIndicator,
  onEnvironmentChange,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  previousWorktreeBranch,
  onUsePreviousWorktree,
}: RunContextSelectorProps) {
  const activeEnvironment =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  const WorkspaceIcon =
    effectiveEnvMode === "worktree"
      ? FolderGit2Icon
      : activeWorktreePath
        ? FolderGitIcon
        : FolderIcon;
  const workspaceLabel = forceNewWorktree
    ? resolveEnvModeLabel("worktree")
    : envModeLocked
      ? resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)
      : effectiveEnvMode === "worktree"
        ? resolveEnvModeLabel("worktree")
        : resolveCurrentWorkspaceLabel(activeWorktreePath);
  const isLocked = envLocked || (envModeLocked && !showEnvironmentPicker);
  const workspacePath =
    forceNewWorktree || (effectiveEnvMode === "worktree" && !activeWorktreePath)
      ? null
      : (activeWorktreePath ?? workspaceRoot);
  const handleContextMenu = (event: ReactMouseEvent) => {
    if (workspacePath) {
      showWorkspaceContextMenu(event, workspacePath);
    }
  };
  const workspaceIcon = (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <WorkspaceIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      </TooltipTrigger>
      <TooltipPopup>
        {forceNewWorktree
          ? "Each model starts in its own worktree."
          : (workspacePath ?? workspaceLabel)}
      </TooltipPopup>
    </Tooltip>
  );
  const icon = showEnvironmentIndicator ? (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
          {autoEnvironmentLabel ? (
            <ScaleIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden="true" />
          ) : (
            <EnvironmentMachineIcon
              kind={activeEnvironment?.machine ?? "server"}
              className={THREAD_DETAILS_PANEL_ICON_CLASS}
            />
          )}
        </TooltipTrigger>
        <TooltipPopup>{autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"}</TooltipPopup>
      </Tooltip>
      {workspaceIcon}
    </span>
  ) : (
    workspaceIcon
  );
  const triggerContent = (
    <>
      {icon}
      <ComposerContextLabel displayMode="panel">
        {autoEnvironmentLabel ??
          (showEnvironmentIndicator ? (activeEnvironment?.label ?? "Run on") : workspaceLabel)}
      </ComposerContextLabel>
    </>
  );

  if (isLocked) {
    return (
      <span
        className={cn(
          "inline-flex h-7 min-w-0 max-w-full flex-initial items-center justify-start gap-1 rounded-md border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6",
          THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
        )}
        onContextMenu={handleContextMenu}
        aria-label="Run context"
      >
        {triggerContent}
      </span>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={<ThreadDetailsControl part="select" />}
        onContextMenu={handleContextMenu}
        onMouseDownCapture={(event) => {
          if (event.button !== 0 || event.ctrlKey) event.stopPropagation();
        }}
        aria-label="Run context"
      >
        {triggerContent}
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="w-(--anchor-width)">
        {showEnvironmentPicker && availableEnvironments && onEnvironmentChange ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Run on</MenuGroupLabel>
              <MenuRadioGroup
                value={autoEnvironmentLabel ? "auto" : environmentId}
                onValueChange={(value) =>
                  value === "auto"
                    ? onAutoEnvironment?.()
                    : onEnvironmentChange(value as EnvironmentId)
                }
              >
                {onAutoEnvironment && (
                  <MenuRadioItem
                    value="auto"
                    disabled={envLocked}
                    closeOnClick
                    onClick={() => {
                      if (autoEnvironmentLabel) onAutoEnvironment?.();
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ScaleIcon className="size-3" aria-hidden="true" />
                      <span className="min-w-0 truncate">
                        {autoEnvironmentLabel ?? "Auto balance"}
                      </span>
                    </span>
                  </MenuRadioItem>
                )}
                {availableEnvironments.map((env) => (
                  <MenuRadioItem
                    key={env.environmentId}
                    disabled={envLocked}
                    value={env.environmentId}
                    closeOnClick
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                      <span className="min-w-0 truncate">{env.label}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          <MenuRadioGroup
            value={effectiveEnvMode}
            onValueChange={(value) => {
              if (value === "previous-worktree") {
                onUsePreviousWorktree();
                return;
              }
              onEnvModeChange(value as EnvMode);
            }}
          >
            <MenuRadioItem disabled={envModeLocked || forceNewWorktree} value="local" closeOnClick>
              <span className="flex min-w-0 items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                <MiddleTruncate value={resolveCurrentWorkspaceLabel(activeWorktreePath)} />
              </span>
            </MenuRadioItem>
            <MenuRadioItem disabled={envModeLocked} value="worktree" closeOnClick>
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderGit2Icon className="size-3" />
                <span className="min-w-0 truncate">{resolveEnvModeLabel("worktree")}</span>
              </span>
            </MenuRadioItem>
            {previousWorktreeLabel ? (
              <MenuRadioItem disabled={envModeLocked} value="previous-worktree" closeOnClick>
                <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
              </MenuRadioItem>
            ) : null}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

export const BranchToolbar = memo(function BranchToolbar({
  panelSection = "all",
  forceNewWorktree = false,
  environmentId,
  threadId,
  slipJayStatus = null,
  draftId,
  onEnvModeChange,
  envMode,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  startFromOrigin,
  onStartFromOriginChange,
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  availableEnvironments,
  onEnvironmentChange,
}: BranchToolbarProps) {
  const threadRef = scopeThreadRef(environmentId, threadId);
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const serverThread = useThreadShell(threadRef);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProject = useProject(activeProjectRef);
  const hasActiveThread = serverThread !== null || draftThread !== null;
  const activeWorktreePath = forceNewWorktree
    ? null
    : (serverThread?.worktreePath ?? draftThread?.worktreePath ?? null);
  const effectiveEnvMode = forceNewWorktree ? "worktree" : envMode;
  // SlipJay allocates a draft's workspace on its first message; there is no checkout to choose.
  const envModeLocked =
    envLocked || slipJayStatus !== null || (serverThread !== null && activeWorktreePath !== null);
  const slipJayRows =
    slipJayStatus === null
      ? null
      : {
          workspace: resolveSlipJayWorkspaceLabel(slipJayStatus, serverThread === null),
          base: resolveSlipJayBaseLabel(slipJayStatus, serverThread === null),
          // A draft's status describes the root checkout, not a workspace's change.
          landing: serverThread === null ? null : slipJayStatus.landing,
        };
  const [landingLogOpen, setLandingLogOpen] = useState(false);
  const openLandingLog = () => setLandingLogOpen(true);
  const landingLogDialog =
    slipJayStatus !== null && slipJayRows?.landing ? (
      <SlipJayLandingLogDialog
        environmentId={environmentId}
        cwd={slipJayStatus.cwd}
        landing={slipJayRows.landing}
        open={landingLogOpen}
        onOpenChange={setLandingLogOpen}
      />
    ) : null;

  const canUsePreviousWorktree =
    draftThread !== null && serverThread === null && !envModeLocked && !forceNewWorktree;
  const projectRefsForWorktreeLookup =
    canUsePreviousWorktree && activeProjectRef ? [activeProjectRef] : [];
  const projectThreads = useThreadShellsForProjectRefs(projectRefsForWorktreeLookup);
  const previousWorktreeSeed = canUsePreviousWorktree
    ? resolvePreviousWorktreeSeed({
        threads: projectThreads,
        currentWorktreePath: activeWorktreePath,
      })
    : null;
  const previousWorktreeLabel = previousWorktreeSeed
    ? resolvePreviousWorktreeLabel(previousWorktreeSeed)
    : null;
  const onUsePreviousWorktree = () => {
    if (!previousWorktreeSeed || !activeProjectRef) return;
    setDraftThreadContext(draftId ?? threadRef, {
      branch: previousWorktreeSeed.branch,
      worktreePath: previousWorktreeSeed.worktreePath,
      envMode: "worktree",
      projectRef: activeProjectRef,
    });
  };

  const showEnvironmentPicker = Boolean(
    availableEnvironments && availableEnvironments.length > 1 && onEnvironmentChange,
  );
  const activeEnvironmentOption =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  if (!hasActiveThread || !activeProject) return null;

  return (
    <div className="flex w-full flex-col" data-thread-panel-run-context>
      {panelSection !== "branch" ? (
        <RunContextSelector
          workspaceRoot={activeProject.workspaceRoot}
          forceNewWorktree={forceNewWorktree}
          autoEnvironmentLabel={autoEnvironmentLabel}
          onAutoEnvironment={onAutoEnvironment}
          envLocked={envLocked}
          envModeLocked={envModeLocked}
          environmentId={environmentId}
          availableEnvironments={availableEnvironments}
          showEnvironmentPicker={showEnvironmentPicker}
          showEnvironmentIndicator={activeEnvironmentOption !== null}
          onEnvironmentChange={onEnvironmentChange}
          effectiveEnvMode={effectiveEnvMode}
          activeWorktreePath={activeWorktreePath}
          onEnvModeChange={onEnvModeChange}
          previousWorktreeLabel={previousWorktreeLabel}
          previousWorktreeBranch={previousWorktreeSeed?.branch ?? null}
          onUsePreviousWorktree={onUsePreviousWorktree}
        />
      ) : null}
      {panelSection !== "workspace" && slipJayRows ? (
        <>
          <SlipJayContextRow
            icon={FolderGitIcon}
            label={slipJayRows.workspace}
            tooltip="SlipJay workspace"
          />
          {slipJayRows.landing !== null ? (
            <SlipJayContextRow
              icon={GitCommitHorizontalIcon}
              label={resolveSlipJayLandingLabel(slipJayRows.landing)}
              tooltip={slipJayRows.landing.reason ?? "Open the landing log"}
              onClick={openLandingLog}
            />
          ) : slipJayRows.base === null ? null : (
            <SlipJayContextRow
              icon={GitBranchIcon}
              label={slipJayRows.base}
              tooltip="Integration branch"
            />
          )}
        </>
      ) : panelSection !== "workspace" ? (
        <BranchToolbarBranchSelector
          displayMode="panel"
          className="w-full"
          environmentId={environmentId}
          threadId={threadId}
          {...(draftId ? { draftId } : {})}
          envLocked={envLocked}
          effectiveEnvModeOverride={effectiveEnvMode}
          {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
          {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
          startFromOrigin={startFromOrigin}
          onStartFromOriginChange={onStartFromOriginChange}
          {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
          {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
        />
      ) : null}
      {landingLogDialog}
    </div>
  );
});
