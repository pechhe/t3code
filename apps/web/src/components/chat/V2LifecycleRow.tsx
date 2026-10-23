import {
  CONTEXT_COMPACTION_WINDOW_TOO_SMALL,
  contextCompactionModelName,
} from "@t3tools/client-runtime/work-log/presentation";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { AgentElapsed } from "./AgentElapsed";
import { projectedSubagentsToRuntime } from "@t3tools/client-runtime/state/subagentRuntime";
import { Fragment, type ReactNode } from "react";
import { useThreadShell, useProject } from "../../state/entities";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { AgentRoleChip } from "../AgentRoleChip";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { environmentThreadDetails } from "../../state/threads";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { MiddleTruncate } from "../ui/middle-truncate";
import * as DateTime from "effect/DateTime";
import { WorkLogRow } from "./WorkLog";
import {
  handoffCrossesAccounts,
  resolveHandoffEndpoints,
  type HandoffEndpoints,
  type HandoffTimelineRun,
} from "@t3tools/client-runtime/handoff";
import {
  formatSubagentDisplayTitle,
  resolveSubagentMetadata,
} from "@t3tools/client-runtime/state/subagent-display";
import { formatTokens } from "@t3tools/shared/usageFormat";
import {
  AGENT_ROLE_TITLE_LABEL,
  agentTaskTopic,
  isReviewerRole,
  ProviderDriverKind,
  type AgentRole,
  type OrchestrationV2Notification,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Subagent,
  type ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
  type EnvironmentId,
  type NodeId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  BotIcon,
  ChevronRightIcon,
  ArrowRightLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  FolderInputIcon,
  GitForkIcon,
  MessageSquareIcon,
  MinusIcon,
  XIcon,
} from "lucide-react";

import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { formatShortTimestamp } from "../../timestampFormat";
import { getTriggerDisplayModelName } from "./providerIconUtils";
import { ProviderInstanceIcon, providerTextColor } from "./ProviderInstanceIcon";
import { cn } from "~/lib/utils";
import { subagentRoundHash } from "~/lib/subagentRoundNavigation";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import {
  subagentFollowUpRound,
  subagentFollowUpVerb,
  subagentReturnStatus,
  subagentReturnVerb,
} from "./V2LifecycleRow.logic";
import { Button, InlineButton } from "../ui/button";
import { T3Wordmark } from "../T3Wordmark";

const LIFECYCLE_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "run_interrupt_request",
  "run_interrupt_result",
  "compaction",
  "handoff",
  "fork",
  "subagent",
  "thread_created",
]);

export function isV2LifecycleItem(item: OrchestrationV2TurnItem): boolean {
  return LIFECYCLE_TYPES.has(item.type);
}

export type { HandoffTimelineRun } from "@t3tools/client-runtime/handoff";

export function V2LifecycleRow(props: {
  readonly item: OrchestrationV2TurnItem;
  readonly environmentId: EnvironmentId;
  readonly resourceSummary?: boolean | undefined;
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
  readonly onOpenThread: (threadId: ThreadId, hash?: string) => void;
}) {
  const { item } = props;
  if (item.type === "run_interrupt_request") {
    return (
      <div className="flex justify-end px-1 py-1" data-v2-item-type={item.type}>
        <div className="flex max-w-[80%] items-center gap-2 text-xs text-destructive">
          <span aria-hidden="true" className="font-mono">
            ■
          </span>
          <span className="font-medium">Interrupt requested</span>
          <span aria-hidden="true" className="opacity-50">
            ·
          </span>
          <span className="font-medium">{item.message}</span>
          <span className="text-3xs text-muted-foreground">
            {formatShortTimestamp(props.createdAt, props.timestampFormat)}
          </span>
        </div>
      </div>
    );
  }
  if (item.type === "run_interrupt_result") {
    if (item.cause === "move" || item.moved === true)
      return <TimelineSystemDivider label={item.message} icon={FolderInputIcon} />;
    return (
      <TimelineSystemDivider
        label="Run interrupted"
        detail={item.message}
        tone={
          item.cause === "provider-abort" || item.cause === "server-close" ? "neutral" : "danger"
        }
        icon={XIcon}
      />
    );
  }
  if (item.type === "compaction") {
    const tokenDetail =
      item.beforeTokenCount === undefined && item.afterTokenCount === undefined
        ? null
        : `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"} tokens`;
    const model = contextCompactionModelName(item);
    const label =
      item.status === "failed"
        ? model
          ? `Context compaction failed on ${model}`
          : "Context compaction failed"
        : item.status === "cancelled" || item.status === "interrupted"
          ? "Context compaction stopped"
          : item.status === "pending" || item.status === "running" || item.status === "waiting"
            ? model
              ? `Compacting context with ${model}`
              : "Compacting context"
            : model
              ? `Context compacted · ${model}`
              : "Context compacted";
    const detail = [
      item.summary ?? tokenDetail,
      item.windowTooSmall ? CONTEXT_COMPACTION_WINDOW_TOO_SMALL : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return <TimelineSystemDivider label={label} detail={detail || null} icon={MinusIcon} />;
  }
  if (item.type === "handoff") {
    return (
      <EnvironmentHandoffRow
        environmentId={props.environmentId}
        endpoints={resolveHandoffEndpoints(item, props.runs)}
        failed={item.status === "failed"}
        // A context rollover hands the thread to a fresh session on the same provider thread.
        rollover={
          item.strategy === "manual_context" &&
          item.fromProviderThreadIds.length === 1 &&
          item.fromProviderThreadIds[0] === item.toProviderThreadId
        }
      />
    );
  }
  if (item.type === "fork") {
    const relatedThreadId = item.source.type === "run" ? item.source.threadId : item.targetThreadId;
    return (
      <TimelineSystemDivider
        label={item.source.type === "run" ? "Forked from conversation" : "Conversation fork"}
        icon={GitForkIcon}
        actionLabel={item.source.type === "run" ? "Open source conversation" : "Open fork"}
        onAction={() => props.onOpenThread(relatedThreadId)}
      />
    );
  }
  if (item.type === "thread_created") {
    if (props.resourceSummary) {
      return (
        <div
          data-v2-item-type={item.type}
          className="flex min-w-0 items-center gap-3 rounded-lg border border-border/60 p-3"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
            <MessageSquareIcon className="size-4 text-secondary-label" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {item.title ?? "Created thread"}
          </span>
          <Button
            size="xs"
            variant="outline"
            aria-label={`Open ${item.title ?? "created thread"}`}
            onClick={() => props.onOpenThread(item.targetThreadId)}
          >
            Open chat
          </Button>
        </div>
      );
    }
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<T3Wordmark className="size-4 text-icon-muted" aria-hidden />}
        label={<>Created thread{item.title ? ` · ${item.title}` : ""}</>}
        trailing={
          <InlineButton
            aria-label={`Open ${item.title ?? "created thread"}`}
            onClick={() => props.onOpenThread(item.targetThreadId)}
          >
            Open chat
          </InlineButton>
        }
      />
    );
  }
  if (item.type === "subagent") {
    return (
      <SubagentTimelineLink
        parentRef={scopeThreadRef(props.environmentId, item.threadId)}
        subagentId={item.subagentId}
        providerInstanceId={item.providerInstanceId}
        origin={item.origin}
        status={item.status}
        driver={item.driver}
        title={formatSubagentDisplayTitle(item.title ?? "Subagent")}
        result={item.result}
        progress={item.progress}
        startedAt={item.startedAt}
        completedAt={item.completedAt}
        threadId={item.childThreadId}
        timestampFormat={props.timestampFormat}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  return null;
}

const STATUS_VISUALS: Record<
  OrchestrationV2TurnItem["status"],
  { dotClass: string; label: string }
> = {
  pending: { dotClass: "bg-info", label: "Queued" },
  running: { dotClass: "bg-info", label: "Running" },
  waiting: { dotClass: "bg-info", label: "Waiting" },
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

function subagentStatusVisual(status: OrchestrationV2TurnItem["status"]) {
  return STATUS_VISUALS[status];
}

const SETTLED_SUBAGENT_STATUSES = new Set<OrchestrationV2TurnItem["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const GENERIC_CHILD_END = /^Child task ended with status\b/i;

function plainDetail(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isoOrNull(value: DateTime.Utc | null | undefined): string | null {
  return value ? DateTime.formatIso(value) : null;
}

export function SubagentElapsed({ agent }: { agent: Parameters<typeof AgentElapsed>[0]["agent"] }) {
  return <AgentElapsed agent={agent} />;
}

function SubagentAvatar({
  driver,
  displayName,
  iconUrl,
  status,
  size = "default",
  className,
}: {
  driver?: ProviderDriverKind | undefined;
  displayName?: string | undefined;
  iconUrl?: string | undefined;
  status?: OrchestrationV2TurnItem["status"] | undefined;
  size?: "default" | "sm" | undefined;
  className?: string;
}) {
  const small = size === "sm";
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted",
        small ? "size-4" : "size-6 ring-2 ring-background",
        className,
      )}
    >
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={displayName ?? driver}
          acpRegistryIconUrl={iconUrl}
          className="z-auto"
          iconClassName={small ? "size-2.5" : "size-3.5"}
        />
      ) : (
        <BotIcon className={cn("text-muted-foreground", small ? "size-2.5" : "size-3.5")} />
      )}
      {status ? (
        <span
          className={cn(
            "absolute -right-px -bottom-px rounded-full",
            small ? "size-1.5 ring-1 ring-background" : "size-2 ring-2 ring-background",
            subagentStatusVisual(status).dotClass,
          )}
        />
      ) : null}
    </span>
  );
}

/**
 * Reads only the two provider fields the avatar draws. Provider status pushes
 * replace the provider objects (fresh `checkedAt`), so selecting strings keeps
 * the avatar from re-rendering when nothing it shows changed.
 */
export function EnvironmentSubagentAvatar({
  environmentId,
  providerInstanceId,
  ...props
}: {
  environmentId: EnvironmentId;
  providerInstanceId: ProviderInstanceId;
  driver?: ProviderDriverKind | undefined;
  status?: OrchestrationV2TurnItem["status"] | undefined;
  size?: "default" | "sm" | undefined;
}) {
  const providersAtom = serverEnvironment.providersValueAtom(environmentId);
  const displayName = useAtomValue(
    providersAtom,
    (providers) =>
      providers?.find((provider) => provider.instanceId === providerInstanceId)?.displayName,
  );
  const iconUrl = useAtomValue(
    providersAtom,
    (providers) =>
      providers?.find((provider) => provider.instanceId === providerInstanceId)?.iconUrl,
  );
  return <SubagentAvatar {...props} displayName={displayName} iconUrl={iconUrl} />;
}

const SUBAGENT_PILL_CLASS =
  "my-1 ml-2 inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1 text-2xs text-muted-foreground transition-colors hover:bg-accent/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset data-[return-highlight]:bg-info/12 data-[return-highlight]:ring-1 data-[return-highlight]:ring-info/40";

/**
 * One compact event involving a subagent: its return, or a follow-up round with an agent that
 * already has a card. Both point at the same child conversation without introducing a new agent.
 */
function SubagentPill(props: {
  readonly parentRef: ScopedThreadRef;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind | undefined;
  readonly status: OrchestrationV2TurnItem["status"] | undefined;
  readonly topic: string;
  readonly round: number | null;
  readonly verb: string;
  readonly failed: boolean;
  readonly timing: ReactNode;
  readonly ariaLabel: string;
  readonly kind: "notification" | "subagent";
  readonly subagentId: NodeId | undefined;
  readonly onActivate: () => void;
  readonly onHighlight: ((highlighted: boolean) => void) | undefined;
  readonly trailing: ReactNode;
}) {
  const highlight = props.onHighlight;
  return (
    <button
      type="button"
      data-v2-item-type={props.kind}
      data-subagent-id={props.subagentId}
      aria-label={props.ariaLabel}
      onPointerEnter={highlight ? () => highlight(true) : undefined}
      onPointerLeave={highlight ? () => highlight(false) : undefined}
      onFocus={highlight ? () => highlight(true) : undefined}
      onBlur={highlight ? () => highlight(false) : undefined}
      onClick={props.onActivate}
      className={cn(
        SUBAGENT_PILL_CLASS,
        props.failed ? "border-destructive/35" : "border-border/70",
      )}
    >
      <EnvironmentSubagentAvatar
        environmentId={props.parentRef.environmentId}
        providerInstanceId={props.providerInstanceId}
        driver={props.driver}
        status={props.status}
        size="sm"
      />
      <span className="min-w-0 truncate font-medium text-foreground">{props.topic}</span>
      {props.round === null ? null : <span className="shrink-0">· Follow-up {props.round}</span>}
      <span className={cn("shrink-0", props.failed && "text-destructive")}>{props.verb}</span>
      {props.timing === null ? null : (
        <>
          <span aria-hidden className="shrink-0 text-muted-foreground/60">
            ·
          </span>
          <span className="shrink-0 tabular-nums">{props.timing}</span>
        </>
      )}
      {props.trailing}
    </button>
  );
}

/** The name a card shows as its role chip plus topic, so a chip identifies the same agent. */
function subagentDisplayName(title: string, role: AgentRole | undefined): string {
  const topic = role ? agentTaskTopic(title, role) : title;
  return role ? [AGENT_ROLE_TITLE_LABEL[role], topic].filter(Boolean).join(" · ") : title;
}

/**
 * Marks where a subagent's result reached the parent. The subagent's own card already shows
 * its live status and result, so this stays a small chip that points back at that card.
 */
export function SubagentReturnChip(props: {
  readonly parentRef: ScopedThreadRef;
  readonly subagentId?: NodeId;
  readonly childThreadId?: ThreadId;
  readonly outcome: OrchestrationV2Notification["outcome"];
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly onHighlight: (subagentId: NodeId, highlighted: boolean) => void;
  readonly onJump: (subagentId: NodeId, childThreadId: ThreadId | null) => void;
  readonly fallback: ReactNode;
}) {
  const agent = useAtomValue(
    environmentThreadDetails.threadAtom(props.parentRef),
    (thread) =>
      thread?.projection.subagents.find((agent) =>
        props.subagentId !== undefined
          ? agent.id === props.subagentId
          : agent.childThreadId === props.childThreadId,
      ) ?? null,
  );
  const childThreadId = agent?.childThreadId ?? props.childThreadId ?? null;
  const round = useAtomValue(environmentThreadDetails.threadAtom(props.parentRef), (thread) =>
    agent === null ? null : subagentFollowUpRound(thread?.projection.subagents ?? [], agent.id),
  );
  const role = useThreadShell(
    childThreadId ? scopeThreadRef(props.parentRef.environmentId, childThreadId) : null,
  )?.source.agentTask?.role;
  if (agent === null) return props.fallback;
  const title = formatSubagentDisplayTitle(agent.title ?? "Subagent");
  const name = subagentDisplayName(title, role);
  const failed = props.outcome === "failed";
  return (
    <SubagentPill
      parentRef={props.parentRef}
      providerInstanceId={agent.providerInstanceId}
      driver={agent.driver}
      status={subagentReturnStatus(props.outcome) ?? agent.status}
      topic={name}
      round={round}
      verb={subagentReturnVerb(props.outcome)}
      failed={failed}
      timing={formatShortTimestamp(props.createdAt, props.timestampFormat)}
      ariaLabel={`Jump to ${name}`}
      kind="notification"
      subagentId={undefined}
      onActivate={() => props.onJump(agent.id, childThreadId)}
      onHighlight={(highlighted) => props.onHighlight(agent.id, highlighted)}
      trailing={<ArrowUpIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />}
    />
  );
}

/**
 * A follow-up with an agent whose assignment already has a card: the same avatar and name, one
 * exchange counted from that assignment, opening the same child conversation.
 */
function SubagentFollowUpChip(props: {
  readonly parentRef: ScopedThreadRef;
  readonly subagentId: NodeId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly status: OrchestrationV2TurnItem["status"];
  readonly name: string;
  readonly round: number;
  readonly reviewing: boolean;
  readonly elapsed: ReactNode;
  readonly onOpen: () => void;
}) {
  return (
    <SubagentPill
      parentRef={props.parentRef}
      providerInstanceId={props.providerInstanceId}
      driver={props.driver}
      status={props.status}
      topic={props.name}
      round={props.round}
      verb={subagentFollowUpVerb(props.status, props.reviewing)}
      failed={props.status === "failed"}
      timing={props.elapsed}
      ariaLabel={`Open ${props.name} · follow-up ${props.round}`}
      kind="subagent"
      subagentId={props.subagentId}
      onActivate={props.onOpen}
      onHighlight={undefined}
      trailing={
        <ArrowUpRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
      }
    />
  );
}

function SubagentTimelineLink(props: {
  readonly parentRef: ScopedThreadRef;
  readonly subagentId: NodeId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly driver: ProviderDriverKind;
  readonly title: string;
  readonly result: string | null;
  readonly progress: string | undefined;
  readonly status: OrchestrationV2TurnItem["status"];
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
  readonly threadId: ThreadId | null;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId, hash?: string) => void;
}) {
  const agent = useAtomValue(
    environmentThreadDetails.threadAtom(props.parentRef),
    (thread) => thread?.projection.subagents.find((agent) => agent.id === props.subagentId) ?? null,
  );
  // A follow-up continues a child conversation that already has a card, so it stays a chip.
  const followUpRound = useAtomValue(
    environmentThreadDetails.threadAtom(props.parentRef),
    (thread) => subagentFollowUpRound(thread?.projection.subagents ?? [], props.subagentId),
  );
  const threadId = props.threadId;
  // A managed task names its role in its title; the row shows it as the role chip instead.
  const role = useThreadShell(
    threadId ? scopeThreadRef(props.parentRef.environmentId, threadId) : null,
  )?.source.agentTask?.role;
  const topic = role ? agentTaskTopic(props.title, role) : props.title;
  const liveStatus = agent?.status ?? props.status;
  const status = liveStatus;
  const statusLabel = subagentStatusVisual(liveStatus).label;
  const result = (agent?.result ?? props.result)?.trim();
  const progress = (agent?.progress ?? props.progress)?.trim();
  const settled = SETTLED_SUBAGENT_STATUSES.has(status);
  const rawDetail = settled ? result || progress : progress || result;
  const detail =
    rawDetail && !GENERIC_CHILD_END.test(rawDetail) ? plainDetail(rawDetail) || null : null;
  const failed = status === "failed";
  const timing = {
    status: liveStatus,
    startedAt: isoOrNull(agent?.startedAt ?? props.startedAt),
    completedAt: isoOrNull(agent?.completedAt ?? props.completedAt),
  };
  const agentModel = agent?.model ?? null;
  // Selects the label string, so a provider status push alone doesn't re-render the card.
  const modelLabel = useAtomValue(
    serverEnvironment.providersValueAtom(props.parentRef.environmentId),
    (providers) =>
      agentModel === null
        ? null
        : resolveSubagentMetadata({
            model: agentModel,
            provider: providers?.find(
              (provider) => provider.instanceId === props.providerInstanceId,
            ),
          }).modelLabel,
  );
  const meta: ReactNode[] = [];
  if (modelLabel !== null) {
    meta.push(modelLabel);
  }
  if (agent?.totalTokens !== undefined) {
    meta.push(`${formatTokens(agent.totalTokens)} tokens`);
  }
  if (followUpRound !== null && threadId !== null) {
    return (
      <SubagentFollowUpChip
        parentRef={props.parentRef}
        subagentId={props.subagentId}
        providerInstanceId={props.providerInstanceId}
        driver={props.driver}
        status={liveStatus}
        name={subagentDisplayName(props.title, role)}
        round={followUpRound}
        reviewing={role !== undefined && isReviewerRole(role)}
        elapsed={<SubagentElapsed agent={timing} />}
        onOpen={() => props.onOpenThread(threadId, subagentRoundHash(props.subagentId))}
      />
    );
  }
  const content = (
    <>
      <EnvironmentSubagentAvatar
        environmentId={props.parentRef.environmentId}
        providerInstanceId={props.providerInstanceId}
        driver={props.driver}
        status={status}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          {role ? <AgentRoleChip role={role} className="shrink-0" /> : null}
          {topic ? (
            <span className="min-w-0 truncate text-xs font-medium text-foreground">{topic}</span>
          ) : null}
          {detail !== null && status !== "completed" ? (
            <span
              className={cn(
                "shrink-0 text-3xs",
                failed ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {statusLabel}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "block text-2xs leading-relaxed",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {detail === null ? (
            statusLabel
          ) : detail.includes("/") && !detail.includes(" ") ? (
            <MiddleTruncate value={detail} showTitle={false} className="flex" />
          ) : (
            <span className="block truncate">{detail}</span>
          )}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end text-xs text-muted-foreground tabular-nums">
        <span>
          <SubagentElapsed agent={timing} />
        </span>
        {meta.length > 0 ? (
          <span className="text-3xs">
            {meta.map((part, index) => (
              <Fragment key={index}>
                {index > 0 ? " · " : null}
                {part}
              </Fragment>
            ))}
          </span>
        ) : null}
      </span>
      {threadId !== null ? (
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover/subagent:text-foreground"
        />
      ) : null}
    </>
  );
  // Return chips highlight their card by toggling `data-return-highlight` on `data-subagent-id`.
  const className =
    "group/subagent flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-[background-color,box-shadow] duration-300 data-return-highlight:bg-info/12 data-return-highlight:ring-1 data-return-highlight:ring-info/40 data-return-highlight:ring-inset";
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          threadId === null ? (
            <div
              data-v2-item-type="subagent"
              data-subagent-id={props.subagentId}
              aria-description={statusLabel}
              className={className}
            >
              {content}
            </div>
          ) : (
            <button
              type="button"
              data-v2-item-type="subagent"
              data-subagent-id={props.subagentId}
              aria-label={`Open ${props.title}`}
              aria-description={statusLabel}
              onClick={() => props.onOpenThread(threadId)}
              className={cn(
                className,
                "cursor-pointer transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
              )}
            >
              {content}
            </button>
          )
        }
      />
      <ThreadHoverCardPopup>
        <SubagentTimelineTooltip
          {...props}
          startedAtIso={timing.startedAt}
          elapsed={agent ? <AgentElapsed agent={projectedSubagentsToRuntime([agent])[0]!} /> : null}
          model={agent?.model ?? null}
          modelSelection={agent?.modelSelection}
          totalTokens={agent?.totalTokens}
          status={liveStatus}
          result={agent?.result ?? props.result}
          progress={agent?.progress ?? props.progress}
        />
      </ThreadHoverCardPopup>
    </Tooltip>
  );
}

function SubagentTimelineTooltip(
  props: Parameters<typeof SubagentTimelineLink>[0] & {
    model: string | null;
    modelSelection: OrchestrationV2Subagent["modelSelection"];
    startedAtIso: string | null;
    elapsed: ReactNode;
    totalTokens: number | undefined;
  },
) {
  const environmentId = props.parentRef.environmentId;
  // The popup only mounts while open, so the full provider list is read here
  // instead of in every timeline row.
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const parent = useThreadShell(props.parentRef)?.source;
  const child = useThreadShell(
    props.threadId ? scopeThreadRef(environmentId, props.threadId) : null,
  )?.source;
  const parentProject = useProject(
    parent ? scopeProjectRef(environmentId, parent.projectId) : null,
  );
  const childProject = useProject(child ? scopeProjectRef(environmentId, child.projectId) : null);
  return (
    <SubagentTooltipContent
      title={formatSubagentDisplayTitle(child?.title ?? props.title)}
      model={props.model}
      providerInstanceId={props.providerInstanceId}
      origin={props.origin}
      modelSelection={props.modelSelection}
      provider={providers.find((provider) => provider.instanceId === props.providerInstanceId)}
      providers={providers}
      driver={props.driver}
      startedAt={props.startedAtIso}
      elapsed={props.elapsed}
      totalTokens={props.totalTokens}
      status={props.status}
      result={props.result}
      progress={props.progress}
      parentThread={parent}
      childThread={child}
      parentProject={parentProject ?? undefined}
      childProject={childProject ?? undefined}
    />
  );
}

function EnvironmentHandoffRow({
  environmentId,
  ...props
}: {
  readonly environmentId: EnvironmentId;
  readonly endpoints: HandoffEndpoints;
  readonly failed: boolean;
  readonly rollover: boolean;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  return <HandoffRow {...props} environmentId={environmentId} providers={providers} />;
}

export function HandoffRow(props: {
  readonly environmentId: EnvironmentId;
  readonly endpoints: HandoffEndpoints;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly pending?: boolean;
  readonly failed?: boolean;
  readonly rollover?: boolean;
}) {
  const { to } = props.endpoints;
  const fromEndpoints = props.rollover ? [] : props.endpoints.from;
  const showAccount = handoffCrossesAccounts(props.endpoints, props.providers);
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(props.environmentId));
  const derived = deriveProviderInstanceEntries(props.providers);
  const entries = settings ? applyProviderInstanceSettings(derived, settings, null) : derived;
  return (
    <TimelineSystemDivider
      label={
        props.rollover
          ? "Context rolled over"
          : props.pending
            ? "Context handoff pending"
            : "Context handoff"
      }
      icon={ArrowRightLeftIcon}
      showDetailSeparator={false}
      tone={props.failed ? "danger" : "neutral"}
      detail={
        <span className="inline-flex min-w-0 flex-wrap items-center justify-center gap-1.5">
          {fromEndpoints.map((endpoint, index) => (
            <span
              key={`${endpoint.instanceId}:${endpoint.model ?? ""}`}
              className="inline-flex min-w-0 items-center"
            >
              <HandoffEndpoint
                entries={entries}
                instanceId={endpoint.instanceId}
                model={endpoint.model}
                showAccount={showAccount}
              />
              {index < fromEndpoints.length - 1 ? (
                <span aria-hidden="true" className="ml-0.5">
                  ,
                </span>
              ) : null}
            </span>
          ))}
          {fromEndpoints.length > 0 ? (
            <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0" />
          ) : null}
          <HandoffEndpoint
            entries={entries}
            instanceId={to.instanceId}
            model={to.model}
            showAccount={showAccount}
          />
        </span>
      }
    />
  );
}

function HandoffEndpoint(props: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly instanceId: ProviderInstanceId;
  readonly model?: string | undefined;
  readonly showAccount: boolean;
}) {
  const entry = props.entries.find((candidate) => candidate.instanceId === props.instanceId);
  const showBadge = entry !== undefined && shouldShowInstanceBadge(entry, props.entries);
  const account = entry?.displayName ?? props.instanceId;
  const model = props.model?.trim();
  const providerModel =
    model === undefined || model.length === 0
      ? undefined
      : entry?.models.find((candidate) => candidate.slug === model);
  const label =
    providerModel !== undefined
      ? getTriggerDisplayModelName(providerModel)
      : model !== undefined && model.length > 0
        ? model
        : (entry?.displayName ?? props.instanceId);
  const labelColor = providerTextColor(
    entry?.driverKind ?? ProviderDriverKind.make(props.instanceId),
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="inline-flex min-w-0 items-center gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <ProviderInstanceIcon
              driverKind={entry?.driverKind ?? ProviderDriverKind.make(props.instanceId)}
              displayName={entry?.displayName ?? props.instanceId}
              accentColor={entry?.accentColor}
              acpRegistryAgentId={entry?.acpRegistryAgentId}
              acpRegistryIconUrl={entry?.acpRegistryIconUrl}
              showBadge={showBadge}
              size="compact"
              iconClassName={cn(showBadge && "opacity-60")}
              indicatorBackground="var(--background)"
            />
            <span
              className={cn("truncate font-medium", labelColor.className)}
              style={labelColor.style}
            >
              {label}
            </span>
            {props.showAccount && account !== label ? (
              <span className="truncate">{account}</span>
            ) : null}
          </span>
        }
      />
      <TooltipPopup>
        {account} · {label}
      </TooltipPopup>
    </Tooltip>
  );
}
