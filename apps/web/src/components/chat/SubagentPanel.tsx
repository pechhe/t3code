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
import { CheckIcon, ChevronRightIcon, CircleXIcon } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useClientSettings } from "~/hooks/useSettings";
import { useSubagentStatus, useThreadShell } from "~/state/entities";
import { environmentThreadShells, threadEnvironment } from "~/state/threads";
import { formatDayAwareTimestamp } from "~/timestampFormat";
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
import { SUBAGENT_STATUS_PRESENTATION } from "./subagentStatusPresentation";
import { useSettledFinished } from "./useSettledFinished";

const COLLAPSED_STORAGE_KEY = "t3code:subagent-panel-collapsed";
const FINISHED_OPEN_STORAGE_KEY = "t3code:subagent-panel-finished-open";
const HOVER_CARD_DELAY_MS = 200;

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

function SubagentSummaryCard({ text }: { readonly text: string }) {
  return (
    <ThreadHoverCardPopup side="top" align="start">
      <p className="line-clamp-8 px-1 py-1.5 text-xs/4 text-foreground/85">
        {text === "" ? "No update yet." : oneLine(text)}
      </p>
    </ThreadHoverCardPopup>
  );
}

function Reveal(props: { readonly open: boolean; readonly children: ReactNode }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-150 ease-out motion-reduce:transition-none",
        props.open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      <div inert={!props.open} className="min-h-0 overflow-hidden">
        {props.children}
      </div>
    </div>
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
  const summary = text || (props.subagent?.progress?.trim() ?? "");
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
            delay={HOVER_CARD_DELAY_MS}
            render={
              <SubagentRowLink
                aria-label={`Open ${title}`}
                onClick={() => props.onOpenThread(threadRef.threadId)}
              />
            }
          >
            {role ? agentTaskTopic(title, role) : title}
          </TooltipTrigger>
          <SubagentSummaryCard text={summary} />
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
      {!asking && isSubagentDoer(role) && summary !== "" ? (
        <p className="mt-0.5 truncate text-muted-foreground">{oneLine(summary).slice(0, 400)}</p>
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
  recentCount,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly subagentIds: ReadonlyArray<ThreadId>;
  readonly recentCount: number;
}) {
  const working = useAtomValue(
    environmentThreadShells.subagentLiveStateAtom(threadRef.environmentId),
    (state) => subagentIds.filter((id) => state.statuses.get(id) === "working").length,
  );
  return (
    <>
      {subagentIds.length + recentCount} subagents
      {working > 0 ? (
        <>
          <ComposerBanner.Separator />
          <span className="font-normal text-muted-foreground">{working} working</span>
        </>
      ) : null}
    </>
  );
}

const FINISHED_OUTCOME: Record<
  string,
  { readonly label: string; readonly className: string; readonly icon: typeof CheckIcon | null }
> = {
  completed: { label: "Done", className: "text-muted-foreground", icon: CheckIcon },
  failed: { label: "Failed", className: "text-destructive", icon: CircleXIcon },
  cancelled: { label: "Stopped", className: "text-muted-foreground", icon: null },
  interrupted: { label: "Stopped", className: "text-muted-foreground", icon: null },
};

function FinishedSubagentRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly subagent: OrchestrationV2Subagent;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { threadRef, subagent } = props;
  const shell = useThreadShell(threadRef);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const title = shell?.title ?? subagent.title ?? "";
  const role = shell?.source.agentTask?.role;
  const message = shell?.source.latestVisibleMessage;
  const summary = message?.role === "assistant" ? message.text.trim() : (subagent.result ?? "");
  const outcome = FINISHED_OUTCOME[subagent.status] ?? FINISHED_OUTCOME.completed!;
  const OutcomeIcon = outcome.icon;
  const startedAt = subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt);
  const completedAt =
    subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt);
  const dim = "opacity-55 group-hover/subagent:opacity-100";
  return (
    <div className="group/subagent relative px-3 py-1.5 not-first:border-t not-first:border-border/70">
      <div className="flex min-w-0 items-center gap-2">
        {role ? <AgentRoleChip role={role} className={cn("flex-none", dim)} /> : null}
        <Tooltip>
          <TooltipTrigger
            delay={HOVER_CARD_DELAY_MS}
            render={
              <SubagentRowLink
                aria-label={`Open ${title}`}
                onClick={() => props.onOpenThread(threadRef.threadId)}
              />
            }
          >
            <span className={cn("font-normal", dim)}>
              {role ? agentTaskTopic(title, role) : title}
            </span>
          </TooltipTrigger>
          <SubagentSummaryCard text={summary} />
        </Tooltip>
        <span className={cn("hidden flex-none text-muted-foreground tabular-nums sm:inline", dim)}>
          {resolveSubagentMetadata({ model: subagent.model }).modelLabel}
          {subagent.totalTokens === undefined ? null : ` · ${formatTokens(subagent.totalTokens)}`}
        </span>
        <span
          className={cn("inline-flex flex-none items-center gap-1 tabular-nums", outcome.className)}
        >
          {OutcomeIcon ? <OutcomeIcon aria-hidden className="size-3" /> : null}
          {outcome.label}
          {startedAt === null ? null : (
            <AgentElapsed agent={{ status: subagent.status, startedAt, completedAt }} />
          )}
        </span>
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 flex-none text-muted-foreground/60 group-hover/subagent:text-foreground"
        />
        <span
          className={cn(
            "w-[3.25rem] flex-none text-center text-muted-foreground tabular-nums",
            dim,
          )}
        >
          {completedAt === null ? null : formatDayAwareTimestamp(completedAt, timestampFormat)}
        </span>
      </div>
    </div>
  );
}

function FinishedSubagents(props: {
  readonly threadRef: ScopedThreadRef;
  readonly settled: ReadonlyArray<OrchestrationV2Subagent>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [open, setOpen] = useLocalStorage(FINISHED_OPEN_STORAGE_KEY, false, Schema.Boolean);
  const failed = props.settled.filter((subagent) => subagent.status === "failed").length;
  return (
    <Reveal open={props.settled.length > 0}>
      <div className="border-t border-border/70">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-1.5 text-start text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 transition-transform duration-150", open && "rotate-90")}
          />
          {props.settled.length} finished
          {failed > 0 ? (
            <span className="text-destructive tabular-nums">· {failed} failed</span>
          ) : null}
        </button>
        <Reveal open={open}>
          <div className="grid max-h-[min(12rem,30dvh)] grid-cols-[minmax(0,1fr)] overflow-y-auto border-t border-border/70">
            {props.settled.map((subagent) =>
              subagent.childThreadId === null ? null : (
                <FinishedSubagentRow
                  key={subagent.childThreadId}
                  threadRef={scopeThreadRef(props.threadRef.environmentId, subagent.childThreadId)}
                  subagent={subagent}
                  onOpenThread={props.onOpenThread}
                />
              ),
            )}
          </div>
        </Reveal>
      </div>
    </Reveal>
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
  readonly finished: ReadonlyArray<OrchestrationV2Subagent>;
  readonly canOperate: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly request: SubagentPanelRequest | null;
  readonly stopAll: ReactNode;
}) {
  const {
    threadRef,
    subagentIds,
    subagents,
    finished,
    canOperate,
    onOpenThread,
    request,
    stopAll,
  } = props;
  const [collapsed, setCollapsed] = useLocalStorage(COLLAPSED_STORAGE_KEY, false, Schema.Boolean);
  const header = subagentIds.length + finished.length > 1;
  const open = !(header && collapsed);
  const settledIds = useSettledFinished(
    threadRef,
    finished.flatMap((subagent) => subagent.childThreadId ?? []),
    open,
  );
  const isSettled = (subagent: OrchestrationV2Subagent) =>
    subagent.childThreadId !== null && settledIds.has(subagent.childThreadId);
  const recentCount = finished.filter((subagent) => !isSettled(subagent)).length;
  const askingRow = request?.rowThreadId;
  const quiet = subagentIds.filter((id) => id !== askingRow);
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
      {header ? (
        <div className="flex min-w-0 items-center gap-1 py-1 ps-1.5 pe-2 font-medium">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-expanded={open}
            aria-label={open ? "Collapse subagents" : "Show subagents"}
            onClick={() => setCollapsed((current) => !current)}
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform duration-150", open && "rotate-90")}
            />
          </Button>
          <span className="min-w-0 truncate">
            <PanelSummary
              threadRef={threadRef}
              subagentIds={subagentIds}
              recentCount={recentCount}
            />
          </span>
          <span className="ms-auto flex flex-none items-center gap-0.5 font-normal">{stopAll}</span>
        </div>
      ) : null}
      <Reveal open={open}>
        {quiet.length > 0 || recentCount > 0 ? (
          <div
            className={cn(
              "grid max-h-[min(15rem,35dvh)] grid-cols-[minmax(0,1fr)] overflow-y-auto",
              header && "border-t border-border/70",
            )}
          >
            {quiet.map(row)}
            {finished.map((subagent) =>
              subagent.childThreadId === null ? null : (
                <Reveal key={subagent.childThreadId} open={!isSettled(subagent)}>
                  <div className={cn((quiet.length > 0 || !header) && "border-t border-border/70")}>
                    <FinishedSubagentRow
                      threadRef={scopeThreadRef(threadRef.environmentId, subagent.childThreadId)}
                      subagent={subagent}
                      onOpenThread={onOpenThread}
                    />
                  </div>
                </Reveal>
              ),
            )}
          </div>
        ) : null}
        <FinishedSubagents
          threadRef={threadRef}
          settled={finished.filter(isSettled)}
          onOpenThread={onOpenThread}
        />
      </Reveal>
      {askingRow === undefined ? null : (
        <div
          className={cn(
            "grid grid-cols-[minmax(0,1fr)]",
            (header || quiet.length > 0) && "border-t border-border/70",
          )}
        >
          {row(askingRow)}
        </div>
      )}
    </div>
  );
}
