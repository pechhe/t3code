import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { GitCommitHorizontalIcon } from "lucide-react";
import { useState } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { type SlipJayCheckoutStatus } from "@t3tools/client-runtime/slipjay-checkout";
import {
  isSlipJayLandRefusal,
  resolveSlipJayLandAvailability,
  resolveSlipJayLandToast,
} from "./BranchToolbar.logic";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./chat/threadDetailsPanelStyles";

/**
 * A SlipJay workspace's primary action in place of commit, push and pull request:
 * `slipjay land`, whose progress and result the composer strip's landing state shows.
 */
export function SlipJayLandControl({
  environmentId,
  threadRef,
  status,
  isDraft,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  status: SlipJayCheckoutStatus;
  isDraft: boolean;
}) {
  const canLand = useAtomValue(vcsEnvironment.slipJayLand.permissionAtom(environmentId));
  const land = useAtomCommand(vcsEnvironment.slipJayLand, { reportFailure: false });
  const [waiting, setWaiting] = useState(false);
  const availability = resolveSlipJayLandAvailability(status, isDraft);
  if (availability === null) return null;
  const busy = waiting || availability === "landing";
  const toastData = threadRef === null ? undefined : { threadRef };

  const onLand = async () => {
    setWaiting(true);
    const result = await land({ environmentId, input: { cwd: status.cwd } });
    setWaiting(false);
    if (result._tag === "Failure") {
      // The landing outlives this request; only the wait was stopped.
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      const refused = isSlipJayLandRefusal(error);
      toastManager.add(
        stackedThreadToast(
          refused
            ? {
                type: "error",
                title: "Could not land",
                description: error instanceof Error ? error.message : "SlipJay could not be run.",
                ...(toastData === undefined ? {} : { data: toastData }),
              }
            : {
                type: "info",
                title: "Stopped waiting for the landing",
                description: "It continues on the runner; the composer strip shows its progress.",
                ...(toastData === undefined ? {} : { data: toastData }),
              },
        ),
      );
      return;
    }
    const { type, title, description } = resolveSlipJayLandToast(result.value);
    toastManager.add(
      stackedThreadToast({
        type,
        title,
        ...(description === undefined ? {} : { description }),
        ...(toastData === undefined ? {} : { data: toastData }),
      }),
    );
  };

  return (
    <ThreadDetailsControl
      size="xs"
      variant="ghost"
      part="row"
      panel
      disabled={!canLand || busy}
      onClick={() => void onLand()}
    >
      <GitCommitHorizontalIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
      <span className={THREAD_DETAILS_PANEL_LABEL_CLASS}>{busy ? "Landing…" : "Land"}</span>
    </ThreadDetailsControl>
  );
}
