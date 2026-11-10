import type { SlipJayCheckoutStatus } from "@t3tools/client-runtime/slipjay-checkout";
import { resolveSlipJayFixPrompt } from "@t3tools/client-runtime/slipjay-checkout";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { SlipJayLandingLogDialog } from "../SlipJayLandingLogDialog";
import { ThreadLandingTicket, type ShownLanding } from "../SlipJayThreadLanding";

/**
 * The thread's landing at the end of the timeline, beside what the thread is doing now:
 * the header's ticket at reading size, from submission until the user dismisses its outcome.
 * The header's copy announces stage changes, so this one stays quiet.
 */
export function ThreadLandingNow({
  environmentId,
  threadRef,
  status,
  landing,
  onComposerFocusRequest,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly status: SlipJayCheckoutStatus;
  readonly landing: ShownLanding;
  readonly onComposerFocusRequest: () => void;
}) {
  const [logOpen, setLogOpen] = useState(false);
  const { data: overview } = useEnvironmentQuery(
    vcsEnvironment.slipJayRunner({ environmentId, input: {} }),
  );
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-(--chat-content-max-width) px-1 pb-2">
      <ThreadLandingTicket
        key={landing.operationId}
        environmentId={environmentId}
        threadRef={threadRef}
        status={status}
        landing={landing}
        overview={overview ?? null}
        headline
        className="h-8 min-w-0 max-w-full text-xs"
        onLog={() => setLogOpen(true)}
        onFix={() => {
          useComposerDraftStore.getState().setPrompt(threadRef, resolveSlipJayFixPrompt(landing));
          onComposerFocusRequest();
        }}
        onOpen={() => setLogOpen(true)}
      />
      <SlipJayLandingLogDialog
        environmentId={environmentId}
        cwd={status.cwd}
        landing={landing}
        open={logOpen}
        onOpenChange={setLogOpen}
      />
    </div>
  );
}
