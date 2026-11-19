import { backgroundWorkIsOnlyWatches } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { subagentActivityLabel } from "@t3tools/client-runtime/state/threads";
import { msg } from "gt-react";
import type { MessageResolver } from "../../i18n/messages";

import type { useSubagentActivity } from "../../state/entities";
import type { SidebarThreadSummary } from "../../types";
import type { SidebarSweepAction } from "./SidebarThreadRow";
import { SUBAGENT_STATUS_PRESENTATION } from "../chat/subagentStatusPresentation";
import {
  hasPlanReadyPrompt,
  shouldRecedeSidebarThread,
  threadStandingAttention,
  type resolveSidebarRowStatus,
} from "../Sidebar.logic";

export function resolveSidebarThreadRowStatus(input: {
  thread: SidebarThreadSummary;
  status: ReturnType<typeof resolveSidebarRowStatus>;
  isUnread: boolean;
  isWoke: boolean;
  isActive: boolean;
  isSelected: boolean;
  variantAction: SidebarSweepAction;
  subagentActivity: ReturnType<typeof useSubagentActivity>;
  resolve: MessageResolver;
}) {
  const { thread, status, isUnread, isWoke, subagentActivity, variantAction, resolve } = input;
  // Own requests come first, so only a thread with none speaks for its subagent.
  const delegatedRequestLabel =
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    subagentActivity !== null &&
    (subagentActivity.status === "approval" || subagentActivity.status === "input")
      ? subagentActivityLabel(subagentActivity)
      : null;
  // Background work always recedes when it is not selected: an unread parent
  // completion must not pull a still-working thread back into the foreground.
  // Ready and action-required rows keep their unread and wake prominence.
  // Standing adds a stalled child and an owner-only wait; a more specific status still wins.
  const standingAttention =
    thread.standing?.question !== undefined || status === "waiting" || status === "ready"
      ? threadStandingAttention(thread.standing, thread.parkedWaitGaveUp)
      : null;
  const planReady = status === "ready" && hasPlanReadyPrompt(thread);
  const shouldRecede =
    standingAttention === null &&
    !planReady &&
    shouldRecedeSidebarThread({
      status,
      isUnread,
      isWoke,
      isActive: input.isActive,
      isSelected: input.isSelected,
    });
  const topStatus =
    standingAttention !== "needs_you" && (status === "preparing" || status === "working")
      ? {
          label:
            status === "preparing"
              ? resolve(msg("Setting up"))
              : thread.goal?.status === "active"
                ? resolve(msg("Goal", { $context: "thread status: working on a goal" }))
                : resolve(msg("Working", { $context: "thread status" })),
          icon: "working" as const,
          className: "text-info-foreground",
        }
      : standingAttention === "needs_you"
        ? {
            label:
              thread.standing?.waitsOnPerson?.need === "acceptance"
                ? resolve(
                    msg("Needs you · accept {reference}", {
                      reference:
                        thread.standing.waitsOnPerson.ref ??
                        `#${thread.standing.waitsOnPerson.number}`,
                    }),
                  )
                : resolve(msg("Needs you")),
            icon: "input" as const,
            className: "text-indigo-600 dark:text-indigo-300",
          }
        : standingAttention === "gave_up"
          ? {
              label: resolve(msg("Wait gave up")),
              icon: "waiting" as const,
              className: "text-warning-foreground",
            }
          : standingAttention === "stalled"
            ? {
                label: resolve(msg("Stalled")),
                icon: "waiting" as const,
                className: "text-warning-foreground",
              }
            : status === "waiting" && subagentActivity !== null
              ? {
                  label: subagentActivityLabel(subagentActivity),
                  icon:
                    subagentActivity.status === "working"
                      ? ("working" as const)
                      : ("waiting" as const),
                  className: SUBAGENT_STATUS_PRESENTATION[subagentActivity.status].className,
                }
              : status === "waiting"
                ? {
                    label: backgroundWorkIsOnlyWatches(thread.pendingBackgroundTasks ?? [])
                      ? resolve(msg("Watching"))
                      : resolve(msg("Waiting", { $context: "thread status" })),
                    icon: "waiting" as const,
                    className: "text-muted-foreground",
                  }
                : status === "approval"
                  ? {
                      label:
                        delegatedRequestLabel ??
                        resolve(msg("Approval", { $context: "thread status: needs approval" })),
                      icon: "approval" as const,
                      className: "text-warning-foreground",
                    }
                  : status === "input"
                    ? {
                        label:
                          delegatedRequestLabel ??
                          resolve(msg("Input", { $context: "thread status: needs user input" })),
                        icon: "input" as const,
                      }
                    : status === "request"
                      ? {
                          label: resolve(
                            msg("Request", { $context: "thread status: guest request" }),
                          ),
                          icon: "request" as const,
                        }
                      : status === "limited"
                        ? {
                            label: resolve(
                              msg("Limited", { $context: "thread status: usage limited" }),
                            ),
                            icon: "failed" as const,
                            className: "text-warning-foreground",
                          }
                        : status === "failed"
                          ? {
                              label: resolve(msg("Failed", { $context: "thread status" })),
                              icon: "failed" as const,
                              className: "text-error-foreground",
                            }
                          : planReady
                            ? {
                                label: resolve(
                                  msg("Plan ready", {
                                    $context: "thread status: a plan awaits review",
                                  }),
                                ),
                                icon: "input" as const,
                                className: "text-violet-600 dark:text-violet-300",
                              }
                            : isWoke
                              ? {
                                  label: resolve(
                                    msg("Woke", {
                                      $context: "thread status: woke from snooze",
                                    }),
                                  ),
                                  icon: "woke" as const,
                                  className: "text-warning-foreground",
                                }
                              : isUnread && variantAction !== "unsnooze"
                                ? {
                                    label: resolve(msg("Done", { $context: "thread status" })),
                                    icon: "done" as const,
                                    className: "text-success",
                                  }
                                : null;
  return { delegatedRequestLabel, standingAttention, planReady, shouldRecede, topStatus };
}
