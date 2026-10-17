import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  formatSlipJayDuration,
  resolveSlipJayOperationLabel,
  resolveSlipJayQueueLabel,
  resolveSlipJayRunnerSummary,
  SLIPJAY_LANDING_STAGES,
  slipJayWorkspaceName,
} from "@t3tools/client-runtime/slipjay-checkout";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  SlipJayRunnerDeploy,
  SlipJayRunnerOperation,
  ThreadId,
} from "@t3tools/contracts";
import { useMemo, useState, type ReactNode } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { SlipJayReleaseDialog } from "./SlipJayReleaseDialog";
import {
  SlipJayMark,
  SlipJayStageDots,
  SlipJayTicket,
  useSlipJaySpec,
  useNow,
} from "./SlipJayTicket";

/** The latest deploy of each repository to each environment, newest first. */
function latestDeploys(deploys: ReadonlyArray<SlipJayRunnerDeploy>) {
  const seen = new Set<string>();
  return deploys.filter((deploy) => {
    const key = `${deploy.repo} ${deploy.environment}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The SlipJay runner this environment follows: its lanes, each open operation linked to
 * the thread whose workspace submitted it, and what staging and production run. Hidden
 * where the environment follows no runner.
 */
export function SlipJayRunnerControl({
  environmentId,
  releaseProject,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  /** The active thread's SlipJay project, which the popover offers to release. */
  releaseProject: { cwd: string; name: string } | null;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const [releaseOpen, setReleaseOpen] = useState(false);
  const canRelease = useAtomValue(vcsEnvironment.slipJayPromote.permissionAtom(environmentId));
  const release = canRelease ? releaseProject : null;
  const { data: overview } = useEnvironmentQuery(
    vcsEnvironment.slipJayRunner({ environmentId, input: {} }),
  );
  const [open, setOpen] = useState(false);
  // Whether a release is possible belongs to the project, not the thread's checkout,
  // which SlipJay removes once it lands. Asked only while the popover is open.
  const { data: releaseStatus } = useEnvironmentQuery(
    open && release !== null
      ? vcsEnvironment.status({ environmentId, input: { cwd: release.cwd } })
      : null,
  );
  const hasRelease = releaseStatus?.slipJay?.hasReleaseBranch !== false;
  const threadShells = useThreadShells(open);
  const threadsByWorkspace = useMemo(() => {
    const threads = new Map<string, { id: ThreadId; title: string }>();
    for (const thread of threadShells) {
      // Delegated threads share their parent's workspace; the submitter is the root thread.
      if (
        thread.environmentId !== environmentId ||
        thread.sideChat ||
        thread.lineage.parentThreadId !== null
      )
        continue;
      const name = slipJayWorkspaceName(thread.worktreePath);
      if (name !== null) threads.set(name, { id: thread.id, title: thread.title });
    }
    return threads;
  }, [environmentId, threadShells]);
  const summary = resolveSlipJayRunnerSummary(overview);
  if (overview === null || summary === null) return null;

  const repositories = new Set(
    [...overview.serial, ...overview.deploy, ...overview.deploys].map((entry) => entry.repo),
  );
  const showRepository = repositories.size > 1;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="shrink-0 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-ring [-webkit-app-region:no-drag]"
              aria-label={`SlipJay: ${summary.label}`}
            />
          }
        >
          <SlipJayTicket
            tone={summary.tone === "busy" ? "running" : "waiting"}
            className="h-6 text-xs"
            stub={<SlipJayMark />}
          >
            <span
              className={cn(
                "pe-2 font-mono max-sm:hidden",
                summary.tone === "attention" && "text-warning",
              )}
            >
              {summary.label}
            </span>
          </SlipJayTicket>
        </PopoverTrigger>
        <PopoverPopup side="bottom" align="end" width="md" padding="compact">
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex items-center gap-2 border-b pb-2">
              <SlipJayMark className="size-4 text-foreground [--jay-beak:var(--color-slipjay)] [--jay-eye:var(--popover)]" />
              <span className="font-mono font-semibold text-xs">slipjay</span>
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  overview.connected ? "bg-slipjay-mint" : "bg-warning",
                )}
              />
              <span className="ms-auto text-muted-foreground text-xs">
                {overview.paused
                  ? "Paused"
                  : overview.connected
                    ? "Runner connected"
                    : "Reconnecting to the runner"}
              </span>
              {/* Shown while reconnecting too: a runner paused before the watch dropped can still be resumed. */}
              <SlipJayPauseButton environmentId={environmentId} paused={overview.paused} />
            </div>
            <RunnerLane
              title="Landing"
              environmentId={environmentId}
              operations={overview.serial}
              threadsByWorkspace={threadsByWorkspace}
              showRepository={showRepository}
              open={open}
              onOpenThread={(threadId) => {
                setOpen(false);
                onOpenThread(threadId);
              }}
            />
            <RunnerLane
              title="Deploys"
              environmentId={environmentId}
              operations={overview.deploy}
              threadsByWorkspace={threadsByWorkspace}
              showRepository={showRepository}
              open={open}
              onOpenThread={(threadId) => {
                setOpen(false);
                onOpenThread(threadId);
              }}
            />
            {overview.deploys.length > 0 || release !== null ? (
              <RunnerSection title="Environments">
                {latestDeploys(overview.deploys).map((deploy) => (
                  <div key={deploy.operationId} className="flex min-w-0 items-baseline gap-2 px-1">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium capitalize">{deploy.environment}</span>{" "}
                      <span className="font-mono text-muted-foreground text-xs">
                        {deploy.commitId.slice(0, 7)}
                      </span>
                      {showRepository ? (
                        <span className="text-muted-foreground"> · {deploy.repo}</span>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-xs",
                        deploy.status === "deployed" ? "text-muted-foreground" : "text-destructive",
                      )}
                    >
                      {deploy.status}
                      {deploy.finishedAt === undefined
                        ? ""
                        : ` ${formatRelativeTimeLabel(deploy.finishedAt)}`}
                    </span>
                  </div>
                ))}
                {release !== null ? (
                  <Button
                    size="xs"
                    variant="outline"
                    className="mx-1 mt-1 self-start"
                    disabled={releaseStatus == null || !hasRelease}
                    onClick={() => {
                      setOpen(false);
                      setReleaseOpen(true);
                    }}
                  >
                    {hasRelease ? `Release ${release.name}…` : "Nothing to release"}
                  </Button>
                ) : null}
              </RunnerSection>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
      {release !== null ? (
        <SlipJayReleaseDialog
          environmentId={environmentId}
          project={release}
          open={releaseOpen}
          onOpenChange={setReleaseOpen}
        />
      ) : null}
    </>
  );
}

function RunnerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="px-1 font-mono font-semibold text-2xs text-muted-foreground uppercase tracking-widest">
        {title}
      </h3>
      {children}
    </section>
  );
}

function RunnerLane({
  title,
  environmentId,
  operations,
  threadsByWorkspace,
  showRepository,
  open,
  onOpenThread,
}: {
  title: string;
  environmentId: EnvironmentId;
  operations: ReadonlyArray<SlipJayRunnerOperation>;
  threadsByWorkspace: ReadonlyMap<string, { id: ThreadId; title: string }>;
  showRepository: boolean;
  open: boolean;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const now = useNow(open && operations.length > 0);
  return (
    <RunnerSection title={title}>
      {operations.length === 0 ? (
        <span className="px-1 text-muted-foreground text-xs">Idle</span>
      ) : (
        operations.map((operation) => (
          <RunnerOperationRow
            key={operation.operationId}
            environmentId={environmentId}
            operation={operation}
            thread={
              operation.workspaceName === undefined
                ? undefined
                : threadsByWorkspace.get(operation.workspaceName)
            }
            showRepository={showRepository}
            now={now}
            onOpenThread={onOpenThread}
          />
        ))
      )}
    </RunnerSection>
  );
}

/**
 * One operation as a ticket. A landing leads with the Spec it delivers, read from the
 * submitting thread's Build link; without one it shows the thread's title.
 */
function RunnerOperationRow({
  environmentId,
  operation,
  thread,
  showRepository,
  now,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  operation: SlipJayRunnerOperation;
  thread: { id: ThreadId; title: string } | undefined;
  showRepository: boolean;
  now: number;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const isLanding = operation.kind === "landing";
  const spec = useSlipJaySpec(
    isLanding && thread !== undefined ? scopeThreadRef(environmentId, thread.id) : null,
  );
  const running = operation.status === "running";
  const stage = SLIPJAY_LANDING_STAGES.indexOf(
    operation.stage as (typeof SLIPJAY_LANDING_STAGES)[number],
  );
  const title = isLanding
    ? (spec?.title ?? thread?.title ?? resolveSlipJayOperationLabel(operation))
    : resolveSlipJayOperationLabel(operation);
  const detail = [
    resolveSlipJayQueueLabel(operation) ?? operation.stage,
    ...(running && operation.submittedAt !== undefined
      ? [formatSlipJayDuration(now - Date.parse(operation.submittedAt))]
      : []),
    ...(thread === undefined && operation.workspaceName === undefined
      ? [operation.submittedBy]
      : []),
    ...(showRepository ? [operation.repo] : []),
  ].join(" · ");
  const heading = (
    <span className="flex min-w-0 items-center gap-1.5">
      {/* Without the workspace's attached Issue a row cannot say there is no Spec. */}
      {spec === null ? null : (
        <span className="shrink-0 font-mono text-muted-foreground text-xs">#{spec.number}</span>
      )}
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      {spec?.held ? (
        <Badge size="sm" variant="warning">
          Held
        </Badge>
      ) : spec?.status ? (
        <Badge size="sm" variant="secondary">
          {spec.status}
        </Badge>
      ) : null}
    </span>
  );
  return (
    <SlipJayTicket
      tone={running ? "running" : "waiting"}
      className="min-h-12"
      stub={
        <span className="flex w-5 flex-col items-center gap-0.5">
          <SlipJayMark />
          {operation.position === undefined ? null : <span>{operation.position}</span>}
        </span>
      }
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5">
        {thread === undefined ? (
          heading
        ) : (
          <button
            type="button"
            className="min-w-0 cursor-pointer rounded-sm text-start hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => onOpenThread(thread.id)}
          >
            {heading}
          </button>
        )}
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          {isLanding && stage >= 0 ? (
            <SlipJayStageDots tone="running" completed={stage} current={stage} />
          ) : null}
          <span className="min-w-0 truncate font-mono">{detail}</span>
        </span>
      </span>
      {operation.status === "queued" ? (
        <span className="shrink-0 pe-1">
          <SlipJayCancelButton environmentId={environmentId} operationId={operation.operationId} />
        </span>
      ) : null}
    </SlipJayTicket>
  );
}

/**
 * Pauses or resumes the runner's queue with `slipjay runner pause|resume`. It is the
 * runner's queue, so it holds landings from every machine, not only this one.
 */
export const slipJayPauseTitle = (paused: boolean) =>
  paused
    ? "Let the runner take the next queued operation from every machine"
    : "Hold queued operations from every machine; a running one finishes";

export function useSlipJayRunnerPause(environmentId: EnvironmentId) {
  const canControl = useAtomValue(
    vcsEnvironment.slipJayRunnerControl.permissionAtom(environmentId),
  );
  const command = useAtomCommand(vcsEnvironment.slipJayRunnerControl, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const control = async (action: "pause" | "resume") => {
    setBusy(true);
    const result = await command({ environmentId, input: { action } });
    setBusy(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: action === "pause" ? "Could not pause the runner" : "Could not resume the runner",
        description: error instanceof Error ? error.message : "SlipJay could not be run.",
      });
    }
  };
  return { canControl, busy, control };
}

function SlipJayPauseButton({
  environmentId,
  paused,
}: {
  environmentId: EnvironmentId;
  paused: boolean;
}) {
  const { canControl, busy, control } = useSlipJayRunnerPause(environmentId);
  if (!canControl) return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      className="shrink-0"
      disabled={busy}
      title={slipJayPauseTitle(paused)}
      onClick={() => void control(paused ? "resume" : "pause")}
    >
      {paused ? "Resume" : "Pause"}
    </Button>
  );
}

/**
 * Withdraws a queued operation with `slipjay cancel`, reporting a refusal; the runner
 * refuses one that has started.
 */
export function useSlipJayCancel(environmentId: EnvironmentId, operationId: string) {
  const canCancel = useAtomValue(vcsEnvironment.slipJayCancel.permissionAtom(environmentId));
  const command = useAtomCommand(vcsEnvironment.slipJayCancel, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const cancel = async () => {
    setBusy(true);
    const result = await command({ environmentId, input: { operationId } });
    setBusy(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not cancel",
        description: error instanceof Error ? error.message : "SlipJay could not be run.",
      });
    } else if (!result.value.cancelled) {
      toastManager.add({
        type: "info",
        title: "Already started",
        description: "The runner had started it, so it was not cancelled.",
      });
    }
  };
  return { canCancel, busy, cancel };
}

function SlipJayCancelButton({
  environmentId,
  operationId,
}: {
  environmentId: EnvironmentId;
  operationId: string;
}) {
  const { canCancel, busy, cancel } = useSlipJayCancel(environmentId, operationId);
  const [confirming, setConfirming] = useState(false);
  if (!canCancel) return null;
  return confirming ? (
    <span className="flex shrink-0 items-center gap-1">
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
        Keep
      </Button>
      <Button
        size="xs"
        variant="destructive"
        disabled={busy}
        onClick={() => void cancel().then(() => setConfirming(false))}
      >
        {busy ? "Cancelling…" : "Cancel it"}
      </Button>
    </span>
  ) : (
    <Button size="xs" variant="ghost" className="shrink-0" onClick={() => setConfirming(true)}>
      Cancel
    </Button>
  );
}
