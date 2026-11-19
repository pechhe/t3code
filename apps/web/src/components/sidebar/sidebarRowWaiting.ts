import {
  effectiveSnoozed,
  parkedThreadSubtitle,
  parkedWaitTimeLeft,
} from "@t3tools/client-runtime/state/thread-settled";
import { msg } from "gt-react";

import type { MessageResolver } from "../../i18n/messages";
import type { SidebarThreadSummary } from "../../types";
import { threadQuestionSubtitle, type SidebarSection } from "../Sidebar.logic";
import { snoozeWakeLabel } from "../Sidebar.snooze";

export function sidebarRowWaitingProps(input: {
  thread: SidebarThreadSummary;
  section: SidebarSection;
  snoozeNow: string;
  messages: MessageResolver;
}) {
  const { thread, section, snoozeNow, messages } = input;
  return {
    snoozeWakeLabelText:
      section !== "snoozed"
        ? null
        : !effectiveSnoozed(thread, { now: snoozeNow }) && (thread.parkedWaits?.length ?? 0) > 0
          ? parkedWaitTimeLeft(thread.parkedWaits, Date.parse(snoozeNow))
          : thread.snoozedUntil != null
            ? snoozeWakeLabel(thread.snoozedUntil, { now: new Date().toISOString() }, messages)
            : null,
    ownerSnoozed: effectiveSnoozed(thread, { now: snoozeNow }),
    parkedSubtitle: effectiveSnoozed(thread, { now: snoozeNow })
      ? messages(msg("Snoozed by you"))
      : (threadQuestionSubtitle(thread, messages) ??
        parkedThreadSubtitle(thread.parkedWaits, Date.parse(snoozeNow))),
  };
}
