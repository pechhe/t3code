import type {
  PendingBackgroundWorkItem,
  WatchTarget,
} from "@t3tools/client-runtime/state/thread-execution";
import { threadShellRelationshipStatus } from "@t3tools/client-runtime/state/thread-relationships";
import {
  parkedWaitFacts,
  parkedWaitKindLabel,
  parkedWaitWakesOn,
  type ParkedWaitKindLabel,
} from "@t3tools/client-runtime/state/thread-settled";
import type {
  EnvironmentId,
  OrchestrationV2ParkedWait,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  AnchorIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  ClockIcon,
  EyeIcon,
  FlagIcon,
  MessageSquareIcon,
  TerminalIcon,
  UserIcon,
  type LucideIcon,
} from "lucide-react";
import { Fragment, type MouseEvent, type ReactNode } from "react";

import { tickTextContent } from "~/lib/tickTextContent";
import { forgeWorkItems } from "~/state/forgeWorkItems";
import { useEnvironmentQuery } from "~/state/query";
import { useThreadRelationshipShells, useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { ForgeMentionChip } from "../forgeItem/ForgeMentionChip";
import { Button, InlineButton } from "../ui/button";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { BackgroundWorkDetails } from "./BackgroundWorkDetails";
import {
  type PanelWait,
  type PanelWaitKind,
  type PanelWaitsOnYou,
  panelWaitKind,
  waitsOnYouText,
} from "./SubagentPanel.logic";
import { threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";
import { useRemoteWatchedThread, WAITING_FOR_CONNECTION } from "./useRemoteWatchedThread";

const KIND_PRESENTATION: Record<PanelWaitKind, { label: string; icon: LucideIcon }> = {
  agent: { label: "Agent", icon: CircleDashedIcon },
  watch: { label: "Watch", icon: EyeIcon },
  command: { label: "Command", icon: TerminalIcon },
};

const KIND_LABEL_BY_GROUP: Partial<Record<PendingBackgroundWorkItem["group"], string>> = {
  thread: "Thread",
  pull_request: "PR",
  build_item: "Forge",
  landing: "Landing",
  monitor: "Monitor",
  background_task: "Task",
};

export interface PanelLinkHandlers {
  readonly threadRef: ScopedThreadRef;
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
  readonly onOpenPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
}

/** The chip slot's quiet kind label: dashed, no tint, so only agents read as colour. */
function PanelKindLabel(props: {
  readonly icon: LucideIcon;
  readonly children: ReactNode;
  readonly you?: boolean;
}) {
  const Icon = props.icon;
  return (
    <span
      className={
        props.you === true
          ? "inline-flex h-5 flex-none items-center gap-1 rounded-md border border-accent-foreground/30 bg-accent px-1.5 font-mono text-3xs font-medium tracking-wide text-accent-foreground uppercase"
          : "inline-flex h-5 flex-none items-center gap-1 rounded-md border border-dashed border-border px-1.5 font-mono text-3xs font-medium tracking-wide text-muted-foreground uppercase"
      }
    >
      <Icon aria-hidden className="size-3" />
      {props.children}
    </span>
  );
}

/** The item's name, as a link when it has somewhere to go. */
function WaitLabel({
  item,
  handlers,
}: {
  readonly item: PendingBackgroundWorkItem;
  readonly handlers: PanelLinkHandlers;
}) {
  const { childThreadId, watching } = item;
  if (childThreadId !== undefined) {
    return (
      <InlineButton
        tone="muted"
        aria-label={`Open subagent ${item.label}`}
        onClick={() => handlers.onOpenThread(childThreadId)}
      >
        {item.label}
      </InlineButton>
    );
  }
  if (watching?.kind === "thread") {
    return <WatchedThreadLink label={item.label} watching={watching} handlers={handlers} />;
  }
  if (watching?.kind === "build_item") {
    return (
      <ForgeMentionChip
        threadRef={handlers.threadRef}
        number={watching.number}
        copy={`#${watching.number}`}
        fallback={item.label}
      />
    );
  }
  if (watching?.kind === "pull_request") {
    return (
      <InlineButton
        tone="muted"
        aria-label={`Open watched pull request ${item.label}`}
        onClick={(event) => handlers.onOpenPullRequest(event, watching.url)}
      >
        {item.label}
      </InlineButton>
    );
  }
  return <>{item.label}</>;
}

type WatchedThread = Extract<WatchTarget, { readonly kind: "thread" }>;

/** The watched thread's name as a link. One in a linked environment opens there, under its name. */
function WatchedThreadLink({
  label,
  watching,
  handlers,
}: {
  readonly label: string;
  readonly watching: WatchedThread;
  readonly handlers: PanelLinkHandlers;
}) {
  const { threadId, environmentId } = watching;
  const remote = useRemoteWatchedThread({
    watcherEnvironmentId: handlers.threadRef.environmentId,
    target: watching,
  });
  return (
    <>
      <InlineButton
        tone="muted"
        aria-label={`Open watched thread ${label}`}
        disabled={environmentId !== undefined && !remote.connected}
        onClick={() => handlers.onOpenThread(threadId, environmentId)}
      >
        {label}
      </InlineButton>
      {remote.environmentLabel === null ? null : (
        <span className="font-normal text-muted-foreground"> on {remote.environmentLabel}</span>
      )}
    </>
  );
}

// Lineage already keeps watched threads' shells, so the panel reads status from the same source.
function LocalWatchedThreadStatus({
  threadRef,
  threadId,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly threadId: ThreadId;
}) {
  const shell = useThreadRelationshipShells(threadRef).find((thread) => thread.id === threadId);
  if (shell === undefined) return null;
  return (
    <span className="flex-none text-muted-foreground">
      {threadRelationshipStatusLabel(threadShellRelationshipStatus(shell))}
    </span>
  );
}

// A thread in a linked environment is never looked up here: its status is read from that
// environment while this client is connected to it, and is "Waiting for connection" until then.
function RemoteWatchedThreadStatus({
  watcherEnvironmentId,
  watching,
}: {
  readonly watcherEnvironmentId: EnvironmentId;
  readonly watching: WatchedThread;
}) {
  const remote = useRemoteWatchedThread({
    watcherEnvironmentId,
    target: watching,
  });
  const text = remote.connected
    ? remote.status === null
      ? null
      : threadRelationshipStatusLabel(remote.status)
    : WAITING_FOR_CONNECTION;
  if (text === null) return null;
  return <span className="flex-none text-muted-foreground">{text}</span>;
}

function WatchedThreadStatus({
  threadRef,
  watching,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly watching: WatchedThread;
}) {
  return watching.environmentId === undefined ? (
    <LocalWatchedThreadStatus threadRef={threadRef} threadId={watching.threadId} />
  ) : (
    <RemoteWatchedThreadStatus watcherEnvironmentId={threadRef.environmentId} watching={watching} />
  );
}

/** A delegated run that went quiet: amber text and an open dot, not an alarm. */
export function StalledStatus({ since }: { readonly since: string }) {
  const sinceMs = Date.parse(since);
  return (
    <span className="inline-flex flex-none items-center gap-1 text-warning-foreground tabular-nums">
      <span aria-hidden className="size-1.5 rounded-full border border-current" />
      No activity{" "}
      <span
        ref={tickTextContent((nowMs) => formatDuration(Math.max(1_000, nowMs - sinceMs)), true)}
      />
    </span>
  );
}

/**
 * Ends one pull request watch. Only a pull request watch has a per-item stop today: thread, Forge
 * and landing watches and commands end together through the header's Stop all.
 */
function StopPullRequestWatch(props: {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
}) {
  const { threadRef, url } = props;
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  const link = useThreadShell(threadRef)?.source.pullRequests?.find(
    (candidate) => candidate.url === url && candidate.watch !== undefined,
  );
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={link === undefined}
      onClick={() => {
        if (link === undefined) return;
        void watch({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            host: link.host,
            repository: link.repository,
            number: link.number,
            watching: false,
          },
        });
      }}
    >
      Stop
    </Button>
  );
}

function WaitElapsed({ startedAtMs }: { readonly startedAtMs: number }) {
  return (
    <span
      ref={tickTextContent((nowMs) => formatDuration(Math.max(1_000, nowMs - startedAtMs)), true)}
      className="tabular-nums"
    />
  );
}

/** A watch, command or monitor the thread waits on, in the same grammar as a subagent row. */
export function WaitRow(props: {
  readonly wait: PanelWait;
  readonly handlers: PanelLinkHandlers;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnItems: ThreadStructure["turnItems"];
  /** Set when the server reports this agent's run as quiet. */
  readonly stalledSince?: string | null;
}) {
  const { wait, handlers } = props;
  const { item } = wait;
  const kind = panelWaitKind(item.group);
  const presentation = KIND_PRESENTATION[kind];
  const mono = item.kind === "command" || item.kind === "monitor";
  return (
    <div className="group/wait relative flex min-w-0 items-center gap-2 px-3 py-2 not-first:border-t not-first:border-border/70">
      <PanelKindLabel icon={presentation.icon}>
        {KIND_LABEL_BY_GROUP[item.group] ?? presentation.label}
      </PanelKindLabel>
      <span
        className={
          mono && item.watching === undefined
            ? "min-w-0 flex-1 truncate font-mono font-normal text-foreground"
            : "min-w-0 flex-1 truncate font-medium text-foreground"
        }
      >
        {kind === "watch" ? (
          <span className="font-normal text-muted-foreground">Watching </span>
        ) : null}
        <WaitLabel item={item} handlers={handlers} />
      </span>
      {props.stalledSince != null ? (
        <StalledStatus since={props.stalledSince} />
      ) : item.watching?.kind === "thread" ? (
        <WatchedThreadStatus threadRef={handlers.threadRef} watching={item.watching} />
      ) : (
        <span
          className={`inline-flex flex-none items-center gap-1 tabular-nums ${wait.awaited ? "text-muted-foreground" : "text-info-foreground"}`}
        >
          {wait.awaited ? "Waiting" : "Running"}
          {wait.startedAtMs === null ? null : <WaitElapsed startedAtMs={wait.startedAtMs} />}
        </span>
      )}
      {wait.task !== undefined && kind === "command" ? (
        <BackgroundWorkDetails
          environmentId={props.environmentId}
          threadId={props.threadId}
          tasks={[wait.task]}
          turnItems={props.turnItems}
          onOpenThread={handlers.onOpenThread}
        />
      ) : null}
      {item.childThreadId !== undefined || item.watching?.kind === "thread" ? (
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 flex-none text-muted-foreground/60 group-hover/wait:text-foreground"
        />
      ) : null}
      <span className="flex w-[3.25rem] flex-none justify-center">
        {item.watching?.kind === "pull_request" ? (
          <StopPullRequestWatch threadRef={handlers.threadRef} url={item.watching.url} />
        ) : null}
      </span>
    </div>
  );
}

/** The wait only the person can end, against the composer, with its own band. */
export function WaitsOnYouRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly waits: PanelWaitsOnYou;
}) {
  const { waits, threadRef } = props;
  const mentions = useEnvironmentQuery(
    forgeWorkItems.mentions({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, numbers: [waits.number] },
    }),
  );
  const link = mentions.data?.items.find((found) => found.number === waits.number);
  const url = link === undefined || link.item === null ? null : link.url;
  return (
    <div
      data-waits-on-you="true"
      className="flex min-w-0 items-center gap-2 border-s-2 border-accent-foreground px-3 py-2"
    >
      <PanelKindLabel icon={UserIcon} you>
        You
      </PanelKindLabel>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        {waitsOnYouText(waits)}
      </span>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-none font-semibold whitespace-nowrap text-accent-foreground hover:underline"
        >
          Open {waits.ref} →
        </a>
      ) : null}
    </div>
  );
}

const PARKED_KIND_ICON: Record<ParkedWaitKindLabel, LucideIcon> = {
  Release: FlagIcon,
  Time: ClockIcon,
  Thread: MessageSquareIcon,
  Forge: FlagIcon,
  Landing: FlagIcon,
};

/**
 * A wait the thread is parked on. Nothing here reads as working: no spinner, no status colour.
 * The times are read at `nowMs`, which the caller moves on a coarse clock.
 */
export function ParkedWaitRow(props: {
  readonly wait: OrchestrationV2ParkedWait;
  readonly threadRef: ScopedThreadRef;
  readonly nowMs: number;
  readonly canOperate: boolean;
}) {
  const { wait, threadRef, nowMs } = props;
  const endWait = useAtomCommand(threadEnvironment.endWait, { reportFailure: true });
  const kind = parkedWaitKindLabel(wait);
  const remote = useRemoteWatchedThread({
    watcherEnvironmentId: threadRef.environmentId,
    target: wait.target.kind === "thread" ? wait.target : null,
  });
  const facts = [
    ...(remote.environmentLabel === null ? [] : [`on ${remote.environmentLabel}`]),
    ...parkedWaitFacts(wait, nowMs),
  ];
  return (
    <div
      data-parked-wait={wait.id}
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 not-first:border-t not-first:border-border/70"
    >
      <PanelKindLabel icon={PARKED_KIND_ICON[kind]}>{kind}</PanelKindLabel>
      <span className="min-w-0 flex-1 basis-48 truncate font-medium text-foreground">
        {parkedWaitWakesOn(wait, nowMs)}
      </span>
      <span className="flex min-w-0 flex-none items-center gap-1.5 text-muted-foreground tabular-nums">
        {facts.map((fact, index) => (
          <Fragment key={fact}>
            {index > 0 ? <span aria-hidden>·</span> : null}
            <span>{fact}</span>
          </Fragment>
        ))}
      </span>
      <span className="flex w-[3.25rem] flex-none justify-center">
        <Button
          size="xs"
          variant="ghost"
          disabled={!props.canOperate}
          onClick={() =>
            void endWait({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, watchId: wait.id },
            })
          }
        >
          Cancel
        </Button>
      </span>
    </div>
  );
}

/** A quiet mono sub-heading over one section of the panel. */
export function PanelSubheading(props: {
  readonly children: ReactNode;
  readonly count: number;
  readonly parked?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 pt-2 pb-0.5 font-mono text-3xs tracking-wide text-muted-foreground uppercase">
      {props.parked === true ? <AnchorIcon aria-hidden className="size-3" /> : null}
      {props.children}
      <span className="tabular-nums">{props.count}</span>
    </div>
  );
}
