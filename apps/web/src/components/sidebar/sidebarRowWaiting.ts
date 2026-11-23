import {
  effectiveSnoozed,
  parkedThreadSubtitle,
  parkedWaitClockLabel,
  parkedWaitStageSubtitle,
} from "@t3tools/client-runtime/state/thread-settled";
import { resolveWorkingThreadTier } from "@t3tools/client-runtime/state/thread-inbox";
import { isVisitedSince } from "@t3tools/shared/threadStanding";
import { msg } from "gt-react";

import type { MessageResolver } from "../../i18n/messages";
import type { SidebarThreadSummary } from "../../types";
import { threadQuestionSubtitle, waitReviewDetail, type SidebarSection } from "../Sidebar.logic";
import { snoozeWakeLabel } from "../Sidebar.snooze";

export function sidebarRowWaitingProps(input: {
  thread: SidebarThreadSummary;
  section: SidebarSection;
  snoozeNow: string;
  messages: MessageResolver;
  lastVisitedAt?: string | null | undefined;
}) {
  const { thread, section, snoozeNow, messages } = input;
  const lastVisitedAt = input.lastVisitedAt ?? thread.lastVisitedAt;
  const nowMs = Date.parse(snoozeNow);
  const ownerSnoozed = effectiveSnoozed(thread, { now: snoozeNow });
  const standing = thread.standing;
  const waiting = standing?.state === "waiting";
  const flagged = standing?.reason === "check_wait" ? standing.waitReview : undefined;
  const review =
    flagged !== undefined && !isVisitedSince(lastVisitedAt, flagged.flaggedAt)
      ? flagged
      : undefined;
  return {
    snoozeWakeLabelText:
      section === "snoozed" && thread.snoozedUntil != null
        ? snoozeWakeLabel(thread.snoozedUntil, { now: new Date().toISOString() }, messages)
        : null,
    /** How long a Working row has waited, or until a time wait wakes; a Check wait row shows it too. */
    waitClockLabel:
      !ownerSnoozed && (waiting || review !== undefined)
        ? parkedWaitClockLabel(thread.parkedWaits, nowMs)
        : null,
    ownerSnoozed,
    parkedSubtitle: ownerSnoozed
      ? messages(msg("Snoozed by you"))
      : (threadQuestionSubtitle(thread, messages) ??
        (review !== undefined
          ? messages(waitReviewDetail(review))
          : waiting && resolveWorkingThreadTier(thread) === "landing"
            ? parkedWaitStageSubtitle(thread.parkedWaits)
            : parkedThreadSubtitle(thread.parkedWaits, nowMs))),
  };
}
