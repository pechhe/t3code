import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadHandoffNotice } from "@t3tools/client-runtime/state/peerLinks";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, MonitorUpIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useConnectedEnvironmentIds } from "~/state/environments";
import { threadHandoffEnvironment } from "~/state/threadHandoff";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { followMovedThread } from "./threadHandoffFollow.logic";

/** Why the composer is closed while a thread moves away, or null when it is open. */
export function threadHandoffSendBlockReason(
  shell: Pick<EnvironmentThreadShell, "handoff"> | null | undefined,
): string | null {
  const handoff = shell?.handoff;
  if (handoff?.state === "departing") return `Moving to ${handoff.label}`;
  if (handoff?.state === "departed") return `Continues on ${handoff.label}`;
  return null;
}

/**
 * The banner for a thread's move to a linked environment: waiting (with
 * Cancel), under way, moved (with a link to it there when this client is
 * connected to that environment), or failed.
 */
export function useThreadHandoffBannerItem(
  shell: Pick<EnvironmentThreadShell, "environmentId" | "id" | "handoff"> | null | undefined,
): ComposerBannerStackItem | null {
  const navigate = useNavigate();
  const cancel = useAtomCommand(threadHandoffEnvironment.cancel, { label: "cancel thread move" });
  const canCancel = useAtomValue(
    threadHandoffEnvironment.cancel.permissionAtom(shell?.environmentId ?? null),
  );
  const [cancelling, setCancelling] = useState(false);
  const handoff = shell?.handoff ?? null;
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const canOpenThere =
    handoff?.state === "departed" && connectedEnvironmentIds.includes(handoff.environmentId);
  // A move seen to finish while its thread is open opens it where it went, so it reads as one thread.
  const shellId = shell?.id ?? null;
  const moving = handoff?.state === "pending" || handoff?.state === "departing";
  const thereEnvironmentId =
    handoff?.state === "departed" && canOpenThere ? handoff.environmentId : null;
  const thereThreadId = handoff?.state === "departed" && canOpenThere ? handoff.threadId : null;
  const seenMoving = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows a move the server finishes, not a user action here
  useEffect(() => {
    if (shellId === null) return;
    const followed = followMovedThread(seenMoving.current, {
      threadId: shellId,
      moving,
      there:
        thereEnvironmentId === null || thereThreadId === null
          ? null
          : scopeThreadRef(thereEnvironmentId, thereThreadId),
    });
    seenMoving.current = followed.seenMoving;
    if (followed.open === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(followed.open),
      replace: true,
    });
  }, [moving, shellId, thereEnvironmentId, thereThreadId, navigate]);
  const notice = threadHandoffNotice(handoff);
  if (shell == null || handoff === null || notice === null) return null;
  const actions =
    handoff.state === "pending" && canCancel ? (
      <Button
        size="xs"
        variant="ghost"
        disabled={cancelling}
        onClick={() => {
          setCancelling(true);
          void cancel({ environmentId: shell.environmentId, input: { threadId: shell.id } }).then(
            (result) => {
              setCancelling(false);
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Could not cancel the move",
                    description: String(squashAtomCommandFailure(result)),
                  }),
                );
              }
            },
          );
        }}
      >
        {cancelling ? "Cancelling…" : "Keep it here"}
      </Button>
    ) : handoff.state === "departed" && canOpenThere ? (
      <Button
        size="xs"
        variant="ghost"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(handoff.environmentId, handoff.threadId)),
          })
        }
      >
        Open on {handoff.label}
        <ArrowUpRightIcon />
      </Button>
    ) : undefined;
  return {
    id: `thread-handoff:${shell.id}:${handoff.handoffId}:${handoff.state}`,
    variant: notice.tone,
    icon: notice.tone === "error" ? <TriangleAlertIcon /> : <MonitorUpIcon />,
    title: notice.title,
    ...(notice.detail === null ? {} : { description: notice.detail }),
    ...(actions === undefined ? {} : { actions }),
  };
}
