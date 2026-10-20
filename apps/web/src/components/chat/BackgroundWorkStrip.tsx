import type { PendingBackgroundWorkItem } from "@t3tools/client-runtime/state/thread-execution";
import { threadShellRelationshipStatus } from "@t3tools/client-runtime/state/thread-relationships";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { MouseEvent } from "react";

import { useThreadRelationshipShells } from "~/state/entities";
import { InlineButton } from "../ui/button";
import { BuildMentionChip } from "../buildItem/BuildMentionChip";
import { ComposerBanner } from "./ComposerBanner";
import { threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";

const KIND_LABELS: Record<PendingBackgroundWorkItem["group"], string> = {
  thread: "Thread",
  pull_request: "PR",
  build_item: "Build",
  subagent: "Agent",
  command: "Command",
  monitor: "Monitor",
  background_task: "Task",
};

export interface BackgroundWorkLinkHandlers {
  readonly threadRef: ScopedThreadRef | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
}

/** The item's name, as a link when it has somewhere to go. */
export function BackgroundWorkItemLabel({
  item,
  handlers,
}: {
  readonly item: PendingBackgroundWorkItem;
  readonly handlers: BackgroundWorkLinkHandlers;
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
    return (
      <InlineButton
        tone="muted"
        aria-label={`Open watched thread ${item.label}`}
        onClick={() => handlers.onOpenThread(watching.threadId)}
      >
        {item.label}
      </InlineButton>
    );
  }
  if (watching?.kind === "build_item" && handlers.threadRef !== null) {
    return (
      <BuildMentionChip
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

/** "Waiting on <name>" with the name linked, when it has somewhere to go. */
export function BackgroundWorkLoneTitle({
  title,
  item,
  handlers,
}: {
  readonly title: string;
  readonly item: PendingBackgroundWorkItem;
  readonly handlers: BackgroundWorkLinkHandlers;
}) {
  const linked = item.childThreadId !== undefined || item.watching !== undefined;
  if (!linked || !title.endsWith(item.label)) return <>{title}</>;
  return (
    <>
      {title.slice(0, title.length - item.label.length)}
      <BackgroundWorkItemLabel item={item} handlers={handlers} />
    </>
  );
}

// Lineage already keeps watched threads' shells, so the strip reads status from the same source.
function WatchedThreadStatus({
  threadRef,
  threadId,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly threadId: ThreadId;
}) {
  const shell = useThreadRelationshipShells(threadRef).find((thread) => thread.id === threadId);
  if (shell === undefined) return null;
  return (
    <span className="flex-none text-3xs/4 text-muted-foreground">
      {threadRelationshipStatusLabel(threadShellRelationshipStatus(shell))}
    </span>
  );
}

function BackgroundWorkRow({
  item,
  handlers,
}: {
  readonly item: PendingBackgroundWorkItem;
  readonly handlers: BackgroundWorkLinkHandlers;
}) {
  return (
    <ComposerBanner.Row render={<li />} className="py-0.5 pe-2">
      <ComposerBanner.Content className="ps-8 sm:ps-7">
        <span className="w-16 flex-none text-3xs/4 font-medium text-muted-foreground uppercase">
          {KIND_LABELS[item.group]}
        </span>
        <span className="min-w-0 truncate">
          <BackgroundWorkItemLabel item={item} handlers={handlers} />
        </span>
      </ComposerBanner.Content>
      {item.watching?.kind === "thread" && handlers.threadRef !== null ? (
        <ComposerBanner.Actions>
          <WatchedThreadStatus threadRef={handlers.threadRef} threadId={item.watching.threadId} />
        </ComposerBanner.Actions>
      ) : null}
    </ComposerBanner.Row>
  );
}

export function BackgroundWorkRows({
  items,
  handlers,
}: {
  readonly items: ReadonlyArray<PendingBackgroundWorkItem>;
  readonly handlers: BackgroundWorkLinkHandlers;
}) {
  return (
    <ComposerBanner.Scroll>
      <ComposerBanner.Children render={<ul role="list" />} aria-label="Waiting on">
        {items.map((item) => (
          <BackgroundWorkRow key={item.taskId} item={item} handlers={handlers} />
        ))}
      </ComposerBanner.Children>
    </ComposerBanner.Scroll>
  );
}
