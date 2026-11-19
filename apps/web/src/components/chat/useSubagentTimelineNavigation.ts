import type { RunId, ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { type RefObject, useEffect, useRef, useState } from "react";

import {
  findRunFirstRowIndex,
  findSubagentCardRow,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import type { WorkGroupViewState } from "./timelineRowContext";

/**
 * A follow-up pill opens the reviewer's conversation at that round rather than at the end.
 * The list is reused across threads, so a consumed anchor is forgotten when the thread changes;
 * opening the same round again from the parent then lands on it again.
 */
export function useSubagentRoundAnchor(input: {
  readonly roundAnchor: { readonly runId: RunId; readonly key: string } | null;
  readonly listIdentityKey: string;
  readonly listReady: boolean;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly navigateTimeline: () => void;
}) {
  const { roundAnchor, listIdentityKey, listReady, listRef, rows, navigateTimeline } = input;
  const roundAnchorScrolledRef = useRef<{ key: string; identity: string } | null>(null);
  const roundAnchorRunId = roundAnchor?.runId ?? null;
  const roundAnchorKey = roundAnchor?.key ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidates a consumed round scroll anchor when the mounted timeline changes
  useEffect(() => {
    const consumed = roundAnchorScrolledRef.current;
    if (consumed !== null && consumed.identity !== listIdentityKey) {
      roundAnchorScrolledRef.current = null;
    }
  }, [listIdentityKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the virtualized list to the requested subagent round after its rows mount
  useEffect(() => {
    const consumed = roundAnchorScrolledRef.current;
    if (
      roundAnchorKey === null ||
      roundAnchorRunId === null ||
      !listReady ||
      !listRef.current ||
      (consumed?.key === roundAnchorKey && consumed.identity === listIdentityKey)
    ) {
      return;
    }
    // The list is reused across threads and resets its own scroll while its data swaps, so land
    // on the round after that swap has laid out rather than during it.
    const frame = {
      current: requestAnimationFrame(() => {
        frame.current = requestAnimationFrame(() => {
          const current = roundAnchorScrolledRef.current;
          if (current?.key === roundAnchorKey && current.identity === listIdentityKey) return;
          const index = findRunFirstRowIndex(rows, roundAnchorRunId);
          if (index < 0) return;
          roundAnchorScrolledRef.current = { key: roundAnchorKey, identity: listIdentityKey };
          navigateTimeline();
          void listRef.current?.scrollToIndex({ index, animated: false, viewOffset: 24 });
        });
      }),
    };
    return () => cancelAnimationFrame(frame.current);
  }, [
    listReady,
    listIdentityKey,
    listRef,
    navigateTimeline,
    roundAnchorKey,
    roundAnchorRunId,
    rows,
  ]);
}

/** Hovering a subagent's return chip highlights its card; clicking jumps to the card and flashes it. */
export function useSubagentCardJump(input: {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly workGroupViewState: WorkGroupViewState;
  readonly prefersReducedMotion: boolean;
  readonly navigateTimeline: () => void;
  readonly preserveDisclosurePosition: (anchorKey: string) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const {
    listRef,
    rows,
    workGroupViewState,
    prefersReducedMotion,
    navigateTimeline,
    preserveDisclosurePosition,
    onOpenThread,
  } = input;
  // A resumed subagent can have a card in several runs; the jump targets the row the lookup chose,
  // and a hover the latest card.
  const subagentCardElement = (subagentId: string, rowId?: string) => {
    const cards = listRef.current
      ?.getScrollableNode()
      ?.querySelectorAll<HTMLElement>(
        `${rowId === undefined ? "" : `[data-timeline-row-id="${CSS.escape(rowId)}"] `}[data-subagent-id="${CSS.escape(subagentId)}"]`,
      );
    return cards && cards.length > 0 ? cards[cards.length - 1]! : null;
  };
  const flashingSubagentRef = useRef<{ card: HTMLElement; timer: number } | null>(null);
  const onHighlightSubagentCard = (subagentId: string, highlighted: boolean) => {
    const card = subagentCardElement(subagentId);
    // A pointer leaving the chip after a jump must not cut the jump's flash short.
    if (!card || (!highlighted && flashingSubagentRef.current?.card === card)) return;
    card.toggleAttribute("data-return-highlight", highlighted);
  };
  const flashSubagentCard = (subagentId: string, rowId: string) => {
    const previous = flashingSubagentRef.current;
    if (previous) {
      window.clearTimeout(previous.timer);
      previous.card.removeAttribute("data-return-highlight");
      flashingSubagentRef.current = null;
    }
    // An animated index scroll mounts the row before it arrives; flash once the card is in view,
    // giving up after about two seconds.
    const attempt = (framesLeft: number) => {
      const card = subagentCardElement(subagentId, rowId);
      const viewport = listRef.current?.getScrollableNode();
      const inView =
        card && viewport
          ? (() => {
              const cardRect = card.getBoundingClientRect();
              const viewportRect = viewport.getBoundingClientRect();
              return cardRect.bottom > viewportRect.top && cardRect.top < viewportRect.bottom;
            })()
          : false;
      if (!card || !inView) {
        if (framesLeft > 1) requestAnimationFrame(() => attempt(framesLeft - 1));
        return;
      }
      card.setAttribute("data-return-highlight", "");
      flashingSubagentRef.current = {
        card,
        timer: window.setTimeout(() => {
          flashingSubagentRef.current = null;
          card.removeAttribute("data-return-highlight");
        }, 1200),
      };
    };
    requestAnimationFrame(() => attempt(120));
  };
  const [subagentGroupRevealRevision, setSubagentGroupRevealRevision] = useState(0);
  const onJumpToSubagentCard = (subagentId: string, childThreadId: ThreadId | null) => {
    const target = findSubagentCardRow(rows, subagentId);
    if (target === null) {
      if (childThreadId !== null) onOpenThread(childThreadId);
      return;
    }
    navigateTimeline();
    if (target.groupId !== null && !workGroupViewState.expandedEntries.has(target.groupId)) {
      preserveDisclosurePosition(target.rowId);
      workGroupViewState.expandedEntries.add(target.groupId);
      setSubagentGroupRevealRevision((revision) => revision + 1);
    }
    void Promise.resolve(
      listRef.current?.scrollToIndex({
        index: target.index,
        animated: !prefersReducedMotion,
        viewOffset: 24,
      }),
    ).then(() => flashSubagentCard(subagentId, target.rowId));
  };
  return { onHighlightSubagentCard, onJumpToSubagentCard, subagentGroupRevealRevision };
}
