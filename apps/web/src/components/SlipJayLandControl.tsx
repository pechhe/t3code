import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { GitCommitHorizontalIcon, SparklesIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import {
  findSlipJayRunnerOperation,
  resolveSlipJayFixPrompt,
  resolveSlipJayQueueLabel,
  type SlipJayCheckoutStatus,
} from "@t3tools/client-runtime/slipjay-checkout";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentQuery } from "~/state/query";
import { useSlipJayCancel } from "./SlipJayRunnerControl";
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
 * While its landing waits it shows the queue and can be cancelled; once it fails, the
 * thread's agent can be asked to fix it.
 */
export function SlipJayLandControl(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  status: SlipJayCheckoutStatus;
  isDraft: boolean;
  onComposerFocusRequest?: () => void;
}) {
  const landing = props.isDraft ? null : props.status.landing;
  return (
    <>
      <SlipJayLandRow {...props} />
      {landing?.status === "active" ? (
        <SlipJayQueuedLandingRow
          environmentId={props.environmentId}
          operationId={landing.operationId}
        />
      ) : null}
      {landing?.status === "failed" && props.threadRef !== null ? (
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="row"
          panel
          onClick={() => {
            if (props.threadRef === null) return;
            useComposerDraftStore
              .getState()
              .setPrompt(props.threadRef, resolveSlipJayFixPrompt(landing));
            props.onComposerFocusRequest?.();
          }}
        >
          <SparklesIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className={THREAD_DETAILS_PANEL_LABEL_CLASS}>Ask agent to fix</span>
        </ThreadDetailsControl>
      ) : null}
    </>
  );
}

/** Where this workspace's landing waits in the runner's queue, and a way to withdraw it. */
function SlipJayQueuedLandingRow({
  environmentId,
  operationId,
}: {
  environmentId: EnvironmentId;
  operationId: string;
}) {
  const { data: overview } = useEnvironmentQuery(
    vcsEnvironment.slipJayRunner({ environmentId, input: {} }),
  );
  const { canCancel, busy, cancel } = useSlipJayCancel(environmentId, operationId);
  const [confirming, setConfirming] = useState(false);
  const operation = findSlipJayRunnerOperation(overview, operationId);
  const queueLabel = operation === null ? null : resolveSlipJayQueueLabel(operation);
  if (queueLabel === null) return null;

  return (
    <ThreadDetailsControl
      size="xs"
      variant="ghost"
      part="row"
      panel
      tone={confirming ? "destructive" : "default"}
      disabled={!canCancel || busy}
      onClick={() =>
        confirming ? void cancel().then(() => setConfirming(false)) : setConfirming(true)
      }
      onBlur={() => setConfirming(false)}
    >
      <XIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
      <span className={THREAD_DETAILS_PANEL_LABEL_CLASS}>
        {busy
          ? "Cancelling…"
          : confirming
            ? "Click again to cancel the landing"
            : `${queueLabel} · Cancel`}
      </span>
    </ThreadDetailsControl>
  );
}

function SlipJayLandRow({
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
