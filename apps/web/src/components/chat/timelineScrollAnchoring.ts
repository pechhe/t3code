import type { MessageId, RunId } from "@t3tools/contracts";

export interface TimelineRunObservation {
  readonly threadKey: string | null;
  readonly hydrated: boolean;
  readonly runId: RunId | null;
}

export function observeTimelineRun(
  previous: TimelineRunObservation | null,
  input: TimelineRunObservation & {
    readonly queued: boolean;
    readonly messageId: MessageId | null;
  },
): { observation: TimelineRunObservation; anchorMessageId: MessageId | null } {
  const observation = {
    threadKey: input.threadKey,
    hydrated: input.hydrated,
    runId: input.queued ? null : input.runId,
  };
  if (previous?.threadKey !== input.threadKey || !previous.hydrated) {
    return { observation, anchorMessageId: null };
  }
  if (
    !input.hydrated ||
    input.runId === null ||
    input.queued ||
    previous.runId === input.runId ||
    input.messageId === null
  ) {
    return { observation: previous, anchorMessageId: null };
  }
  return { observation, anchorMessageId: input.messageId };
}
import type { RunAttemptId } from "@t3tools/contracts";
import { CHAT_LIST_ANCHOR_OFFSET } from "@t3tools/shared/chatList";

// Match the titlebar fade inset so draft promotion preserves the first row's position.
export const CHAT_TIMELINE_ANCHOR_OFFSET = 24;

// Tuned by eye on a 120 Hz display; measured in real time, so it holds at any refresh rate.
const NEW_TURN_EASE_MS = 47;
const NEW_TURN_FIRST_FRAME_MS = 16;

export type NewTurnEaseStep =
  | { readonly kind: "wait" }
  | { readonly kind: "settle" }
  | { readonly kind: "scroll"; readonly scrollTop: number };

/**
 * One frame of the ease that brings a sent message to the top. `elapsedMs` is null on the
 * first frame, which moves a full frame's worth so the scroll starts at speed.
 */
export function stepNewTurnEase(input: {
  readonly anchorTop: number | undefined;
  readonly scrollTop: number;
  readonly maxScrollTop: number;
  readonly elapsedMs: number | null;
}): NewTurnEaseStep {
  if (input.anchorTop === undefined) return { kind: "wait" };
  const target = Math.min(
    Math.max(0, input.anchorTop - CHAT_LIST_ANCHOR_OFFSET),
    Math.max(0, input.maxScrollTop),
  );
  const remaining = target - input.scrollTop;
  if (Math.abs(remaining) < 0.5) return { kind: "settle" };
  const dt = Math.min(50, Math.max(0, input.elapsedMs ?? NEW_TURN_FIRST_FRAME_MS));
  return {
    kind: "scroll",
    scrollTop: input.scrollTop + remaining * (1 - Math.exp(-dt / NEW_TURN_EASE_MS)),
  };
}

export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface AnchoredTurnMetrics {
  readonly anchorTop: number;
  readonly lastBottom: number;
  readonly turnHeight: number;
  readonly usableViewportHeight: number;
  readonly visibleUsableBottom: number;
  readonly overflowsUsableViewport: boolean;
  readonly targetScrollToRevealEnd: number;
  readonly scrollDeltaToRevealEnd: number;
}

function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

/**
 * The list's own content length includes the composer inset spacer, so this
 * measures from the last row instead. Unknown row positions or an unmeasured
 * viewport counts as fitting.
 */
export function timelineContentOverflowsViewport(
  state: TimelineListMeasurementState | undefined,
  input: { readonly composerInset: number; readonly anchorOffset: number },
): boolean {
  if (!state || !state.data || state.data.length === 0) {
    return false;
  }
  const scrollLength = state.scrollLength;
  if (typeof scrollLength !== "number" || !Number.isFinite(scrollLength) || scrollLength <= 0) {
    return false;
  }
  const lastIndex = state.data.length - 1;
  // Overflow can use an unmeasured tail's lower bound; anchored-turn metrics need its height.
  const lastTop = state.positionAtIndex(lastIndex);
  const lastBottom =
    getRowBottom(state, lastIndex) ??
    (typeof lastTop === "number" && Number.isFinite(lastTop) ? lastTop + 1 : null);
  if (lastBottom === null) {
    return false;
  }
  const visibleScrollLength = Math.max(0, scrollLength - input.composerInset - input.anchorOffset);
  return lastBottom > visibleScrollLength;
}

export function getAnchoredTurnMetrics({
  state,
  anchorIndex,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly state: TimelineListMeasurementState;
  readonly anchorIndex: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): AnchoredTurnMetrics | null {
  if (state.data.length === 0) {
    return null;
  }

  const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
  const anchorTop = state.positionAtIndex(boundedAnchorIndex);
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (typeof anchorTop !== "number" || !Number.isFinite(anchorTop) || lastBottom === null) {
    return null;
  }

  const usableViewportHeight = Math.max(
    0,
    state.scrollLength - composerOverlayHeight - anchorOffset,
  );
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const visibleUsableBottom = state.scroll + usableViewportHeight;
  const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
  const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd,
  };
}

export interface RememberedTimelinePosition {
  readonly rowId: string;
  readonly offsetWithinRow: number;
  readonly scrollOffset: number;
  readonly atEnd: boolean;
  readonly disclosures?: {
    readonly runs: ReadonlySet<RunId>;
    readonly workGroups: ReadonlySet<string>;
    readonly attempts: ReadonlySet<RunAttemptId>;
    readonly workGroupState: {
      scrollPositions: Map<string, { readonly entryId: string; readonly offset: number }>;
      expandedEntries: Set<string>;
    };
  };
}

const rememberedTimelinePositions = new Map<string, RememberedTimelinePosition>();

export function readTimelinePosition(threadKey: string) {
  return rememberedTimelinePositions.get(threadKey);
}

export function rememberTimelinePosition(
  threadKey: string,
  position: RememberedTimelinePosition,
  liveFollowEnabled: boolean,
) {
  rememberedTimelinePositions.delete(threadKey);
  rememberedTimelinePositions.set(threadKey, {
    ...position,
    atEnd: liveFollowEnabled || position.atEnd,
  });
  if (rememberedTimelinePositions.size > 100) {
    const oldest = rememberedTimelinePositions.keys().next().value;
    if (oldest !== undefined) rememberedTimelinePositions.delete(oldest);
  }
}
