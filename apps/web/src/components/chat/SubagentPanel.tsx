import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isSubagentDoer } from "@t3tools/client-runtime/state/threads";
import {
  agentTaskTopic,
  type OrchestrationV2Subagent,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import { formatTokens } from "@t3tools/shared/usageFormat";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useSubagentStatus, useThreadShell } from "~/state/entities";
import { environmentThreadShells, threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { AgentRoleChip } from "../AgentRoleChip";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { ComposerBanner } from "./ComposerBanner";
import {
  ComposerDelegatedRequestSource,
  DelegatedRequestContext,
} from "./ComposerDelegatedRequestSource";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { SUBAGENT_STATUS_PRESENTATION } from "./subagentStatusPresentation";

const COLLAPSED_STORAGE_KEY = "t3code:subagent-panel-collapsed";

function oneLine(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A subagent's live status and how long its run has gone, read from its shell alone. */
export function SubagentStatusText({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const status = useSubagentStatus(threadRef);
  const startedAt = useThreadShell(threadRef)?.source.activityRunStartedAt ?? null;
  if (status === null) return null;
  const { label, className } = SUBAGENT_STATUS_PRESENTATION[status];
  const timed = status === "working" || status === "waiting";
  return (
    <span className={cn("inline-flex flex-none items-center gap-1 tabular-nums", className)}>
      {label}
      {timed && startedAt !== null ? (
        <AgentElapsed
          agent={{
            status: "running",
            startedAt: DateTime.formatIso(startedAt),
            completedAt: null,
          }}
        />
      ) : null}
    </span>
  );
}

function subagentModel(
  subagent: OrchestrationV2Subagent | undefined,
  selectedModel: string | undefined,
) {
  return subagent?.model ?? selectedModel ?? null;
}

// Providers are read only while a row's card is open, so a row carries no extra subscription.
function SubagentRowCard(props: {
  readonly threadRef: ScopedThreadRef;
  readonly subagent: OrchestrationV2Subagent | undefined;
  readonly latestMessage: string;
}) {
  const shell = useThreadShell(props.threadRef)?.source;
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.threadRef.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  if (shell === undefined) return null;
  return (
    <SubagentTooltipContent
      title={shell.title}
      model={subagentModel(props.subagent, shell.modelSelection.model)}
      providerInstanceId={shell.providerInstanceId}
      origin="app_owned"
      modelSelection={shell.modelSelection}
      provider={providers.find((provider) => provider.instanceId === shell.providerInstanceId)}
      providers={providers}
      startedAt={shell.activityRunStartedAt ? DateTime.formatIso(shell.activityRunStartedAt) : null}
      totalTokens={props.subagent?.totalTokens}
      status={props.subagent?.status ?? "running"}
      childThread={shell}
      footer={
        props.latestMessage === "" ? undefined : (
          <p className="line-clamp-8 border-t border-border/60 pt-2 pl-0.5 text-xs/4 text-foreground/85">
            {props.latestMessage}
          </p>
        )
      }
    />
  );
}

// Its ::after covers the row, so the whole row opens the thread and shows its card.
function SubagentRowLink(props: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className="min-w-0 flex-1 cursor-pointer truncate text-start font-medium text-foreground after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring/70"
    />
  );
}

function SubagentRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly subagent: OrchestrationV2Subagent | undefined;
  readonly canOperate: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly request: SubagentPanelRequest | null;
}) {
  const { threadRef, request } = props;
  const shell = useThreadShell(threadRef);
  const status = useSubagentStatus(threadRef);
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn);
  const [stopping, setStopping] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const title = shell?.title ?? "";
  const role = shell?.source.agentTask?.role;
  const message = shell?.source.latestVisibleMessage;
  const text = message?.role === "assistant" ? message.text.trim() : "";
  // A request opens below, so its context waits here until asked for.
  const asking = status === "approval" || status === "input";
  const askedThroughThisRow =
    request !== null && request.askerRef.threadId !== threadRef.threadId ? request.askerRef : null;
  const modelLabel = resolveSubagentMetadata({
    model: subagentModel(props.subagent, shell?.source.modelSelection.model),
  }).modelLabel;
  const totalTokens = props.subagent?.totalTokens;
  const stop = async () => {
    setStopping(true);
    await interruptTurn({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    setStopping(false);
  };
  return (
    <div className="group/subagent relative px-3 py-2 not-first:border-t not-first:border-border/70">
      <div className="flex min-w-0 items-center gap-2">
        {role ? <AgentRoleChip role={role} className="flex-none" /> : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <SubagentRowLink
                aria-label={`Open ${title}`}
                onClick={() => props.onOpenThread(threadRef.threadId)}
              />
            }
          >
            {role ? agentTaskTopic(title, role) : title}
          </TooltipTrigger>
          <ThreadHoverCardPopup side="top" align="start">
            <SubagentRowCard
              threadRef={threadRef}
              subagent={props.subagent}
              latestMessage={oneLine(text)}
            />
          </ThreadHoverCardPopup>
        </Tooltip>
        <span className="hidden flex-none text-muted-foreground tabular-nums sm:inline">
          {modelLabel}
          {totalTokens === undefined ? null : ` · ${formatTokens(totalTokens)}`}
        </span>
        <SubagentStatusText threadRef={threadRef} />
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 flex-none text-muted-foreground/60 group-hover/subagent:text-foreground"
        />
        <span className="relative z-1 flex flex-none items-center gap-0.5">
          {asking && askedThroughThisRow === null && text !== "" ? (
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={contextOpen}
              onClick={() => setContextOpen((open) => !open)}
            >
              {contextOpen ? "Hide context" : "Show context"}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            disabled={!props.canOperate || stopping}
            onClick={() => void stop()}
          >
            {stopping ? "Stopping..." : "Stop"}
          </Button>
        </span>
      </div>
      {!asking && isSubagentDoer(role) && text !== "" ? (
        <p className="mt-0.5 truncate text-muted-foreground">{oneLine(text).slice(0, 400)}</p>
      ) : null}
      {asking && contextOpen && askedThroughThisRow === null ? (
        <div className="relative z-1 mt-1.5">
          <DelegatedRequestContext threadRef={threadRef} text={text} cwd={shell?.worktreePath} />
        </div>
      ) : null}
      {request === null ? null : (
        <div
          data-chat-composer-collapsed-controls="true"
          className="relative z-1 mt-1.5 border-t border-border/70 pt-1.5 @container [--composer-banner-icon-column:--spacing(7)] [--composer-banner-padding-block:--spacing(1)] sm:[--composer-banner-icon-column:--spacing(6)]"
        >
          {askedThroughThisRow === null ? null : (
            <ComposerDelegatedRequestSource
              threadRef={askedThroughThisRow}
              kind={request.kind}
              onOpenThread={request.onOpenThread}
            />
          )}
          {request.panel}
        </div>
      )}
    </div>
  );
}

function PanelSummary({
  threadRef,
  subagentIds,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly subagentIds: ReadonlyArray<ThreadId>;
}) {
  const working = useAtomValue(
    environmentThreadShells.subagentLiveStateAtom(threadRef.environmentId),
    (state) => subagentIds.filter((id) => state.statuses.get(id) === "working").length,
  );
  return (
    <>
      {subagentIds.length} subagents
      {working > 0 ? (
        <>
          <ComposerBanner.Separator />
          <span className="font-normal text-muted-foreground">{working} working</span>
        </>
      ) : null}
    </>
  );
}

export interface SubagentPanelRequest {
  /** The row it opens in: the thread's direct child, which may have passed it up from below. */
  readonly rowThreadId: ThreadId;
  readonly askerRef: ScopedThreadRef;
  readonly kind: "approval" | "input";
  readonly panel: ReactNode;
  readonly onOpenThread: (threadId: ThreadId) => void;
}

/**
 * A thread's delegated subagents pinned just above the composer as one solid panel. A request
 * opens in its asker's row, last so that it sits against the composer that answers it.
 */
export function SubagentPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly subagentIds: ReadonlyArray<ThreadId>;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly canOperate: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly request: SubagentPanelRequest | null;
  readonly stopAll: ReactNode;
}) {
  const { threadRef, subagentIds, subagents, canOperate, onOpenThread, request, stopAll } = props;
  const [collapsed, setCollapsed] = useLocalStorage(COLLAPSED_STORAGE_KEY, false, Schema.Boolean);
  const several = subagentIds.length > 1;
  const askingRow = request?.rowThreadId;
  const quiet = several && collapsed ? [] : subagentIds.filter((id) => id !== askingRow);
  const row = (threadId: ThreadId) => (
    <SubagentRow
      key={threadId}
      threadRef={scopeThreadRef(threadRef.environmentId, threadId)}
      subagent={subagents.findLast((subagent) => subagent.childThreadId === threadId)}
      canOperate={canOperate}
      onOpenThread={onOpenThread}
      request={threadId === askingRow ? request : null}
    />
  );
  return (
    <div
      data-subagent-panel="true"
      className="mb-2 overflow-hidden rounded-xl border border-border/70 bg-card text-xs/4 shadow-xs"
    >
      {several ? (
        <div className="flex min-w-0 items-center gap-1.5 py-1 ps-3 pe-2 font-medium">
          <ComposerBanner.Dot className="text-muted-foreground" />
          <span className="min-w-0 truncate">
            <PanelSummary threadRef={threadRef} subagentIds={subagentIds} />
          </span>
          <span className="ms-auto flex flex-none items-center gap-0.5 font-normal">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Show subagents" : "Collapse subagents"}
              onClick={() => setCollapsed((current) => !current)}
            >
              <ChevronDownIcon className={cn("size-3.5", collapsed && "rotate-180")} />
            </Button>
            {stopAll}
          </span>
        </div>
      ) : null}
      {quiet.length > 0 ? (
        <div
          className={cn(
            "grid max-h-[min(15rem,35dvh)] grid-cols-[minmax(0,1fr)] overflow-y-auto",
            several && "border-t border-border/70",
          )}
        >
          {quiet.map(row)}
        </div>
      ) : null}
      {askingRow === undefined ? null : (
        <div
          className={cn(
            "grid grid-cols-[minmax(0,1fr)]",
            (several || quiet.length > 0) && "border-t border-border/70",
          )}
        >
          {row(askingRow)}
        </div>
      )}
    </div>
  );
}
