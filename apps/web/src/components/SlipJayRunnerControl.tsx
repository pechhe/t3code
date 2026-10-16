import { useAtomValue } from "@effect/atom-react";
import {
  resolveSlipJayOperationLabel,
  resolveSlipJayQueueLabel,
  resolveSlipJayRunnerSummary,
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

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { formatRelativeTimeLabel } from "~/timestampFormat";

const TONE_DOT_CLASS = {
  idle: "bg-muted-foreground/50",
  busy: "bg-info",
  attention: "bg-warning",
} as const;

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
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { data: overview } = useEnvironmentQuery(
    vcsEnvironment.slipJayRunner({ environmentId, input: {} }),
  );
  const [open, setOpen] = useState(false);
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0 [-webkit-app-region:no-drag]"
            aria-label={summary.label}
          />
        }
      >
        <span aria-hidden className={cn("size-1.5 rounded-full", TONE_DOT_CLASS[summary.tone])} />
        <span className="max-sm:hidden">{summary.label}</span>
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="md" padding="compact">
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">
              {overview.connected ? "Runner connected" : "Reconnecting to the runner"}
            </span>
            {overview.paused ? <span className="text-warning text-xs">Paused</span> : null}
          </div>
          <RunnerLane
            title="Serial lane"
            environmentId={environmentId}
            operations={overview.serial}
            threadsByWorkspace={threadsByWorkspace}
            showRepository={showRepository}
            onOpenThread={(threadId) => {
              setOpen(false);
              onOpenThread(threadId);
            }}
          />
          <RunnerLane
            title="Deploy lane"
            environmentId={environmentId}
            operations={overview.deploy}
            threadsByWorkspace={threadsByWorkspace}
            showRepository={showRepository}
            onOpenThread={(threadId) => {
              setOpen(false);
              onOpenThread(threadId);
            }}
          />
          {overview.deploys.length > 0 ? (
            <RunnerSection title="Environments">
              {latestDeploys(overview.deploys).map((deploy) => (
                <div key={deploy.operationId} className="flex min-w-0 items-baseline gap-2 px-2">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="capitalize">{deploy.environment}</span>{" "}
                    <span className="font-mono text-xs">{deploy.commitId.slice(0, 8)}</span>
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
            </RunnerSection>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function RunnerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-2 text-muted-foreground text-xs">{title}</h3>
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
  onOpenThread,
}: {
  title: string;
  environmentId: EnvironmentId;
  operations: ReadonlyArray<SlipJayRunnerOperation>;
  threadsByWorkspace: ReadonlyMap<string, { id: ThreadId; title: string }>;
  showRepository: boolean;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  return (
    <RunnerSection title={title}>
      {operations.length === 0 ? (
        <span className="px-2 text-muted-foreground">Idle</span>
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
            onOpenThread={onOpenThread}
          />
        ))
      )}
    </RunnerSection>
  );
}

function RunnerOperationRow({
  environmentId,
  operation,
  thread,
  showRepository,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  operation: SlipJayRunnerOperation;
  thread: { id: ThreadId; title: string } | undefined;
  showRepository: boolean;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const label = thread?.title ?? resolveSlipJayOperationLabel(operation);
  const detail = [
    resolveSlipJayQueueLabel(operation) ?? operation.stage,
    ...(thread === undefined && operation.workspaceName === undefined
      ? [operation.submittedBy]
      : []),
    ...(showRepository ? [operation.repo] : []),
  ].join(" · ");
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          operation.status === "running" ? "bg-info" : "bg-warning",
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="truncate">{label}</span>
        <span className="truncate text-muted-foreground text-xs">{detail}</span>
      </span>
    </>
  );
  return (
    <div className="flex min-w-0 items-start gap-1">
      {thread === undefined ? (
        <div className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1">{body}</div>
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-md px-2 py-1 hover:bg-accent"
          onClick={() => onOpenThread(thread.id)}
        >
          {body}
        </button>
      )}
      {operation.status === "queued" ? (
        <SlipJayCancelButton environmentId={environmentId} operationId={operation.operationId} />
      ) : null}
    </div>
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
