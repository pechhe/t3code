import {
  findSlipJayRunnerOperation,
  resolveSlipJayLandingChip,
  resolveSlipJayStageProgress,
  type SlipJayCheckoutStatus,
} from "@t3tools/client-runtime/slipjay-checkout";
import type { EnvironmentId, ScopedThreadRef, SlipJayRunnerOverview } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import {
  SlipJayMark,
  SlipJaySpecLink,
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
export const dismissLanding = (environmentId: EnvironmentId, operationId: string) => {
  dismissedLandings.add(dismissalKey(environmentId, operationId));
  for (const listener of dismissListeners) listener();
};

/** The thread's landing until the user dismisses it once it has finished. */
export function useShownLanding(
  environmentId: EnvironmentId,
  status: SlipJayCheckoutStatus | null,
) {
  const landing = status?.landing ?? null;
  const dismissed = useSyncExternalStore(subscribeDismissed, () =>
    landing === null
      ? false
      : dismissedLandings.has(dismissalKey(environmentId, landing.operationId)),
  );
  return dismissed ? null : landing;
}

export type ShownLanding = NonNullable<SlipJayCheckoutStatus["landing"]>;

const TAG_TRIGGER =
  "-ms-1 flex min-w-0 self-stretch cursor-pointer items-center gap-2 rounded-sm px-1 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring";

/** A SlipJay tag's body that opens the runner popover. */
export function SlipJayPopoverTag({ label, children }: { label: string; children: ReactNode }) {
  return (
    <PopoverTrigger
      render={<button type="button" className={TAG_TRIGGER} aria-label={`SlipJay: ${label}`} />}
    >
      {children}
    </PopoverTrigger>
  );
}

/** How the thread's landing reads: the runner's row adds its queue place and timing. */
export function useThreadLanding(
  threadRef: ScopedThreadRef,
  status: SlipJayCheckoutStatus,
  landing: ShownLanding,
  overview: SlipJayRunnerOverview | null,
) {
  const operation = findSlipJayRunnerOperation(overview, landing.operationId);
  const now = useNow(landing.status === "active");
  const chip = resolveSlipJayLandingChip(landing, operation, now);
  const spec = useSlipJaySpec(
    threadRef,
    landing.spec ?? operation?.spec ?? status.workspace?.issueNumber,
  );
  return { now, chip, spec };
}

/**
 * The thread's landing as a ticket: the stub carries the Spec, linked to Forge, and the body
 * opens the runner popover, or calls `onOpen` where there is none. A failed landing offers
 * its log and a fix in place. `headline` leads with Landing or Landed and the commit, for
 * where the ticket stands without the header's context. Only one copy should `announce`.
 */
export function ThreadLandingTicket({
  environmentId,
  threadRef,
  status,
  landing,
  overview,
  onOpen,
  headline = false,
  announce = false,
  extra,
  className,
  onLog,
  onFix,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  status: SlipJayCheckoutStatus;
  landing: ShownLanding;
  overview: SlipJayRunnerOverview | null;
  onOpen?: () => void;
  headline?: boolean;
  announce?: boolean;
  extra?: ReactNode;
  className: string;
  onLog: () => void;
  onFix: () => void;
}) {
  const { chip, spec } = useThreadLanding(threadRef, status, landing, overview);
  const progress = resolveSlipJayStageProgress(landing);
  const outcome = headline && chip.tone === "landed" ? chip.detail : chip.label;
  const body = (
    <>
      {headline ? (
        <span className="shrink-0 font-medium">
          {chip.tone === "landed" ? "Landed" : "Landing"}
        </span>
      ) : null}
      {spec?.title ? (
        <span
          className={cn(
            "min-w-0 truncate",
            headline ? "text-muted-foreground max-sm:hidden" : "max-w-48 font-medium max-lg:hidden",
          )}
        >
          {spec.title}
        </span>
      ) : null}
      {outcome === null ? null : (
        <span
          role={announce ? "status" : undefined}
          className={cn(
            "shrink-0 font-mono",
            chip.tone === "failed" && "text-destructive",
            chip.tone === "landed" && "text-slipjay-mint-strong dark:text-slipjay-mint",
          )}
        >
          {outcome}
        </span>
      )}
      {chip.tone === "ended" ? null : (
        <SlipJayStageDots
          tone={chip.tone}
          completed={progress.completed}
          current={progress.current}
        />
      )}
      {chip.tone === "waiting" && chip.detail !== null ? (
        <span className="shrink-0 font-mono text-muted-foreground max-sm:hidden">
          {chip.detail}
        </span>
      ) : null}
      {chip.elapsed === null ? null : (
        <span
          className={cn(
            "shrink-0 font-mono tabular-nums max-sm:hidden",
            chip.slow && "text-warning",
          )}
        >
          {chip.elapsed}
        </span>
      )}
      {extra}
    </>
  );
  return (
    <SlipJayTicket
      tone={chip.tone}
      // Keyed by operation at the call site, so a landing seen on screen tears as it lands,
      // and one already landed when shown starts torn.
      torn={landing.status === "landed"}
      className={className}
      stub={
        <>
          <SlipJayMark />
          {spec === null ? null : <SlipJaySpecLink spec={spec} />}
        </>
      }
    >
      {onOpen === undefined ? (
        <SlipJayPopoverTag label={chip.label}>{body}</SlipJayPopoverTag>
      ) : (
        <button
          type="button"
          className={TAG_TRIGGER}
          aria-label={`SlipJay landing: ${chip.label}. Open its log`}
          onClick={onOpen}
        >
          {body}
        </button>
      )}
      <span className="flex shrink-0 items-center pe-0.5">
        {chip.tone === "failed" ? (
          <>
            <Button size="xs" variant="ghost" className="max-sm:hidden" onClick={onLog}>
              Log
            </Button>
            <Button size="xs" variant="ghost" title="Ask the agent to fix it" onClick={onFix}>
              Fix
            </Button>
          </>
        ) : null}
        {landing.status === "active" ? null : (
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
  );
}
