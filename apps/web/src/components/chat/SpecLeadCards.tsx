import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { agentTaskTopic, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useSubagentStatus, useThreadShell } from "~/state/entities";
import { environmentThreadShells, threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { AgentRoleChip } from "../AgentRoleChip";
import { Button } from "../ui/button";
import { AgentElapsed } from "./AgentElapsed";
import { ComposerBanner } from "./ComposerBanner";
import { DelegatedRequestContext } from "./ComposerDelegatedRequestSource";
import { SUBAGENT_STATUS_PRESENTATION } from "./subagentStatusPresentation";

const COLLAPSED_STORAGE_KEY = "t3code:spec-lead-cards-collapsed";

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

function SpecLeadRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly canOperate: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly requestPanel: ReactNode;
}) {
  const shell = useThreadShell(props.threadRef);
  const status = useSubagentStatus(props.threadRef);
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn);
  const [stopping, setStopping] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const title = shell?.title ?? "";
  const message = shell?.source.latestVisibleMessage;
  const text = message?.role === "assistant" ? message.text.trim() : "";
  // A request opens in the composer below, so its context waits here until asked for.
  const asking = status === "approval" || status === "input";
  const stop = async () => {
    setStopping(true);
    await interruptTurn({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId },
    });
    setStopping(false);
  };
  return (
    <div className="group/lead relative px-3 py-2 not-first:border-t not-first:border-border/70">
      <div className="flex min-w-0 items-center gap-2">
        <AgentRoleChip role="lead" className="flex-none" />
        <button
          type="button"
          aria-label={`Open ${title}`}
          onClick={() => props.onOpenThread(props.threadRef.threadId)}
          className="min-w-0 flex-1 cursor-pointer truncate text-start font-medium text-foreground after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring/70"
        >
          {agentTaskTopic(title, "lead")}
        </button>
        <SubagentStatusText threadRef={props.threadRef} />
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 flex-none text-muted-foreground/60 group-hover/lead:text-foreground"
        />
        <span className="relative z-1 flex flex-none items-center gap-0.5">
          {asking && text !== "" ? (
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
      {!asking && text !== "" ? (
        <p className="mt-0.5 truncate text-muted-foreground">{oneLine(text).slice(0, 400)}</p>
      ) : null}
      {asking && contextOpen ? (
        <div className="relative z-1 mt-1.5">
          <DelegatedRequestContext
            threadRef={props.threadRef}
            text={text}
            cwd={shell?.worktreePath}
          />
        </div>
      ) : null}
      {props.requestPanel === null ? null : (
        <div
          data-chat-composer-collapsed-controls="true"
          className="relative z-1 mt-1.5 border-t border-border/70 pt-1.5 @container [--composer-banner-icon-column:--spacing(7)] [--composer-banner-padding-block:--spacing(1)] sm:[--composer-banner-icon-column:--spacing(6)]"
        >
          {props.requestPanel}
        </div>
      )}
    </div>
  );
}

function LeadsSummary({
  threadRef,
  leadIds,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly leadIds: ReadonlyArray<ThreadId>;
}) {
  const working = useAtomValue(
    environmentThreadShells.subagentLiveStateAtom(threadRef.environmentId),
    (state) => leadIds.filter((id) => state.statuses.get(id) === "working").length,
  );
  return (
    <>
      {leadIds.length} Spec leads
      {working > 0 ? (
        <>
          <ComposerBanner.Separator />
          <span className="font-normal text-muted-foreground">{working} working</span>
        </>
      ) : null}
    </>
  );
}

export interface SpecLeadCardRequest {
  readonly threadId: ThreadId;
  readonly panel: ReactNode;
}

/**
 * Spec leads pinned just above the composer as one solid panel. A lead's question or permission
 * opens in its own row, last so that it sits against the composer that answers it.
 */
export function SpecLeadCards(props: {
  readonly threadRef: ScopedThreadRef;
  readonly leadIds: ReadonlyArray<ThreadId>;
  readonly canOperate: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly request: SpecLeadCardRequest | null;
  readonly stopAll: ReactNode;
}) {
  const { threadRef, leadIds, canOperate, onOpenThread, request, stopAll } = props;
  const [collapsed, setCollapsed] = useLocalStorage(COLLAPSED_STORAGE_KEY, false, Schema.Boolean);
  const several = leadIds.length > 1;
  const asking = request?.threadId;
  const quiet = leadIds.filter((threadId) => threadId !== asking);
  const shown = [...(several && collapsed ? [] : quiet), ...(asking === undefined ? [] : [asking])];
  return (
    <div
      data-spec-lead-cards="true"
      className="mb-2 overflow-hidden rounded-xl border border-border/70 bg-card text-xs/4 shadow-xs"
    >
      {several ? (
        <div className="flex min-w-0 items-center gap-1.5 py-1 ps-3 pe-2 font-medium">
          <ComposerBanner.Dot className="text-muted-foreground" />
          <span className="min-w-0 truncate">
            <LeadsSummary threadRef={threadRef} leadIds={leadIds} />
          </span>
          <span className="ms-auto flex flex-none items-center gap-0.5 font-normal">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Show Spec leads" : "Collapse Spec leads"}
              onClick={() => setCollapsed((current) => !current)}
            >
              <ChevronDownIcon className={cn("size-3.5", collapsed && "rotate-180")} />
            </Button>
            {stopAll}
          </span>
        </div>
      ) : null}
      <div
        className={cn(
          "grid grid-cols-[minmax(0,1fr)]",
          several && shown.length > 0 && "border-t border-border/70",
        )}
      >
        {shown.map((threadId) => (
          <SpecLeadRow
            key={threadId}
            threadRef={scopeThreadRef(threadRef.environmentId, threadId)}
            canOperate={canOperate}
            onOpenThread={onOpenThread}
            requestPanel={threadId === asking ? request?.panel : null}
          />
        ))}
      </div>
    </div>
  );
}
