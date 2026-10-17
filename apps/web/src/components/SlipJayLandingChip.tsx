import {
  findSlipJayRunnerOperation,
  resolveSlipJayFixPrompt,
  resolveSlipJayLandingChip,
  resolveSlipJayStageProgress,
  type SlipJayCheckoutStatus,
} from "@t3tools/client-runtime/slipjay-checkout";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { Button } from "./ui/button";
import { SlipJayLandingLogDialog } from "./SlipJayLandingLogDialog";
import { useSlipJayCancel } from "./SlipJayRunnerControl";
import {
  SlipJayMark,
  SlipJayStageDots,
  SlipJayTicket,
  useNow,
  useSlipJaySpec,
} from "./SlipJayTicket";

// Finished landings the user put away, by environment and operation, for as long as the app runs.
const dismissedLandings = new Set<string>();
const dismissListeners = new Set<() => void>();
const subscribeDismissed = (listener: () => void) => {
  dismissListeners.add(listener);
  return () => dismissListeners.delete(listener);
};
const dismissalKey = (environmentId: EnvironmentId, operationId: string) =>
  `${environmentId} ${operationId}`;
const dismissLanding = (environmentId: EnvironmentId, operationId: string) => {
  dismissedLandings.add(dismissalKey(environmentId, operationId));
  for (const listener of dismissListeners) listener();
};

/**
 * The thread's SlipJay landing as a ticket above the composer: the Spec it delivers, where
 * it waits or which stage it runs, how long it has taken and, once it ends, the outcome
 * with what to do next. A finished landing stays until it is dismissed.
 */
export function SlipJayLandingChip(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  status: SlipJayCheckoutStatus;
  onComposerFocusRequest?: () => void;
}) {
  const landing = props.status.landing;
  const dismissed = useSyncExternalStore(subscribeDismissed, () =>
    landing === null
      ? false
      : dismissedLandings.has(dismissalKey(props.environmentId, landing.operationId)),
  );
  if (landing === null || dismissed) return null;
  return <LandingTicket key={landing.operationId} {...props} landing={landing} />;
}

function LandingTicket({
  environmentId,
  threadRef,
  status,
  landing,
  onComposerFocusRequest,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  status: SlipJayCheckoutStatus;
  landing: NonNullable<SlipJayCheckoutStatus["landing"]>;
  onComposerFocusRequest?: () => void;
}) {
  const active = landing.status === "active";
  const { data: overview } = useEnvironmentQuery(
    active ? vcsEnvironment.slipJayRunner({ environmentId, input: {} }) : null,
  );
  const operation = findSlipJayRunnerOperation(overview, landing.operationId);
  const now = useNow(active);
  const chip = resolveSlipJayLandingChip(landing, operation, now);
  const progress = resolveSlipJayStageProgress(landing);
  const spec = useSlipJaySpec(threadRef, status.workspace?.issueNumber);
  const [logOpen, setLogOpen] = useState(false);

  return (
    <div className="flex min-w-0 pb-1.5">
      <SlipJayTicket
        tone={chip.tone}
        // Keyed by operation, so a landing seen on screen tears as it lands, and one
        // already landed when shown starts torn.
        torn={landing.status === "landed"}
        className="h-7 max-w-full text-xs"
        stub={
          <>
            <SlipJayMark />
            {spec === null ? null : <span>#{spec.number}</span>}
          </>
        }
      >
        {spec?.title ? (
          <span className="min-w-0 max-w-56 truncate font-medium">{spec.title}</span>
        ) : null}
        <span
          role="status"
          className={
            chip.tone === "failed"
              ? "shrink-0 font-mono text-destructive"
              : chip.tone === "landed"
                ? "shrink-0 font-mono text-slipjay-mint-strong dark:text-slipjay-mint"
                : "shrink-0 font-mono"
          }
        >
          {chip.label}
        </span>
        {chip.tone === "ended" ? null : (
          <SlipJayStageDots
            tone={chip.tone}
            completed={progress.completed}
            current={progress.current}
          />
        )}
        {chip.detail === null ? null : (
          <span className="shrink-0 font-mono text-muted-foreground">{chip.detail}</span>
        )}
        {chip.elapsed === null ? null : (
          <span className="shrink-0 font-mono tabular-nums">{chip.elapsed}</span>
        )}
        <span className="flex shrink-0 items-center pe-0.5">
          {chip.tone === "waiting" ? (
            <CancelLanding environmentId={environmentId} operationId={landing.operationId} />
          ) : null}
          {chip.tone === "failed" ? (
            <>
              <Button size="xs" variant="ghost" onClick={() => setLogOpen(true)}>
                Log
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  useComposerDraftStore
                    .getState()
                    .setPrompt(threadRef, resolveSlipJayFixPrompt(landing));
                  onComposerFocusRequest?.();
                }}
              >
                Ask agent to fix
              </Button>
            </>
          ) : null}
          {active ? null : (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Dismiss landing"
              onClick={() => dismissLanding(environmentId, landing.operationId)}
            >
              <XIcon />
            </Button>
          )}
        </span>
      </SlipJayTicket>
      {chip.tone === "failed" ? (
        <SlipJayLandingLogDialog
          environmentId={environmentId}
          cwd={status.cwd}
          landing={landing}
          open={logOpen}
          onOpenChange={setLogOpen}
        />
      ) : null}
    </div>
  );
}

function CancelLanding({
  environmentId,
  operationId,
}: {
  environmentId: EnvironmentId;
  operationId: string;
}) {
  const { canCancel, busy, cancel } = useSlipJayCancel(environmentId, operationId);
  const [confirming, setConfirming] = useState(false);
  if (!canCancel) return null;
  return (
    <Button
      size="xs"
      variant={confirming ? "destructive" : "ghost"}
      disabled={busy}
      onBlur={() => setConfirming(false)}
      onClick={() =>
        confirming ? void cancel().then(() => setConfirming(false)) : setConfirming(true)
      }
    >
      {busy ? "Cancelling…" : confirming ? "Cancel landing" : "Cancel"}
    </Button>
  );
}
