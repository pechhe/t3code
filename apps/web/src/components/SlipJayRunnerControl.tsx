import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  findSlipJayRunnerOperation,
  resolveSlipJayFixPrompt,
  resolveSlipJayLandingChip,
  resolveSlipJayOperationElapsed,
  resolveSlipJayOperationLabel,
  resolveSlipJayQueueLabel,
  resolveSlipJayRunnerSummary,
  resolveSlipJayStageProgress,
  SLIPJAY_LANDING_STAGES,
  type SlipJayCheckoutStatus,
  slipJayWorkspaceName,
} from "@t3tools/client-runtime/slipjay-checkout";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ScopedThreadRef,
  SlipJayRunnerDeploy,
  SlipJayRunnerOperation,
  SlipJayRunnerOverview,
  ThreadId,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState, useSyncExternalStore, type ReactNode } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
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
import { SlipJayLandingDetails } from "./SlipJayLandingDetails";
import { SlipJayLandingLogDialog } from "./SlipJayLandingLogDialog";
import { SlipJayReleaseDialog } from "./SlipJayReleaseDialog";
import {
  SlipJayMark,
  SlipJaySpecLink,
  SlipJayStageDots,
  SlipJayTicket,
  useSlipJaySpec,
  useNow,
} from "./SlipJayTicket";

/** A repository key without its owner, which is the same for every repository a runner serves. */
const repositoryName = (repo: string) => repo.slice(repo.indexOf("/") + 1);

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

/** The thread's landing until the user dismisses it once it has finished. */
function useShownLanding(environmentId: EnvironmentId, status: SlipJayCheckoutStatus | null) {
  const landing = status?.landing ?? null;
  const dismissed = useSyncExternalStore(subscribeDismissed, () =>
    landing === null
      ? false
      : dismissedLandings.has(dismissalKey(environmentId, landing.operationId)),
  );
  return dismissed ? null : landing;
}

type ShownLanding = NonNullable<SlipJayCheckoutStatus["landing"]>;

/**
 * The one place a thread shows SlipJay: the tag leads with the thread's own landing (its
 * Spec, stage and time, then the outcome and what to do next until it is dismissed) and
 * otherwise with what the runner is doing. The popover pins the thread's landing above the
 * runner's lanes, each open operation named by its Spec and linked to the thread whose
 * workspace submitted it, and what staging and production run. Hidden where the thread
 * has no landing and the environment follows no runner.
 */
export function SlipJayRunnerControl({
  environmentId,
  threadRef,
  slipJayStatus,
  releaseProject,
  onOpenThread,
  onComposerFocusRequest,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  slipJayStatus: SlipJayCheckoutStatus | null;
  /** The active thread's SlipJay project, which the popover offers to release. */
  releaseProject: { cwd: string; name: string } | null;
  onOpenThread: (threadId: ThreadId) => void;
  onComposerFocusRequest?: () => void;
}) {
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
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
  const threadsByWorkspace = new Map<string, { id: ThreadId; title: string }>();
  for (const thread of threadShells) {
    // Delegated threads share their parent's workspace; the submitter is the root thread.
    if (
      thread.environmentId !== environmentId ||
      thread.sideChat ||
      thread.lineage.parentThreadId !== null
    )
      continue;
    const name = slipJayWorkspaceName(thread.worktreePath);
    if (name !== null) threadsByWorkspace.set(name, { id: thread.id, title: thread.title });
  }
  const landing = useShownLanding(environmentId, slipJayStatus);
  const summary = resolveSlipJayRunnerSummary(overview, landing?.operationId);
  if (slipJayStatus === null || landing === null) {
    if (overview == null || summary === null) return null;
  }

  const openThread = (threadId: ThreadId) => {
    setOpen(false);
    onOpenThread(threadId);
  };
  const openLog = () => {
    setOpen(false);
    setLogOpen(true);
  };
  const askAgentToFix = (failed: ShownLanding) => {
    setOpen(false);
    useComposerDraftStore.getState().setPrompt(threadRef, resolveSlipJayFixPrompt(failed));
    onComposerFocusRequest?.();
  };
  const repositories = new Set(
    overview == null
      ? []
      : [...overview.serial, ...overview.deploy, ...overview.deploys].map((entry) => entry.repo),
  );
  const showRepository = repositories.size > 1;
  const withoutLanding = (operations: ReadonlyArray<SlipJayRunnerOperation>) =>
    landing === null
      ? operations
      : operations.filter((operation) => operation.operationId !== landing.operationId);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        {slipJayStatus !== null && landing !== null ? (
          <ThreadLandingTag
            key={landing.operationId}
            environmentId={environmentId}
            threadRef={threadRef}
            status={slipJayStatus}
            landing={landing}
            overview={overview ?? null}
            others={summary === null ? 0 : summary.others + (summary.lead === null ? 0 : 1)}
            onLog={openLog}
            onFix={() => askAgentToFix(landing)}
          />
        ) : summary !== null ? (
          <RunnerTag
            environmentId={environmentId}
            threadRef={threadRef}
            summary={summary}
            threadsByWorkspace={threadsByWorkspace}
          />
        ) : null}
        <PopoverPopup side="bottom" align="end" width="lg" padding="compact">
          <div className="flex flex-col gap-3 text-sm">
            {overview == null ? null : (
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
            )}
            {slipJayStatus !== null && landing !== null ? (
              <RunnerSection title="This thread">
                <ThreadLandingSection
                  environmentId={environmentId}
                  threadRef={threadRef}
                  status={slipJayStatus}
                  landing={landing}
                  overview={overview ?? null}
                  onLog={openLog}
                  onFix={() => askAgentToFix(landing)}
                />
              </RunnerSection>
            ) : null}
            {overview == null ? null : (
              <>
                <RunnerLane
                  title="Landing"
                  environmentId={environmentId}
                  lookupRef={threadRef}
                  operations={withoutLanding(overview.serial)}
                  threadsByWorkspace={threadsByWorkspace}
                  showRepository={showRepository}
                  open={open}
                  onOpenThread={openThread}
                />
                <RunnerLane
                  title="Deploys"
                  environmentId={environmentId}
                  lookupRef={threadRef}
                  operations={overview.deploy}
                  threadsByWorkspace={threadsByWorkspace}
                  showRepository={showRepository}
                  open={open}
                  onOpenThread={openThread}
                />
              </>
            )}
            {overview != null && (overview.deploys.length > 0 || release !== null) ? (
              <RunnerSection title="Environments">
                {latestDeploys(overview.deploys).map((deploy) => (
                  <div
                    key={deploy.operationId}
                    className="flex min-w-0 items-baseline gap-2 px-1 text-xs"
                  >
                    <span className="shrink-0 font-medium text-sm capitalize">
                      {deploy.environment}
                    </span>
                    {showRepository ? (
                      <span className="min-w-0 truncate text-muted-foreground">
                        {repositoryName(deploy.repo)}
                      </span>
                    ) : null}
                    <span className="ms-auto shrink-0 font-mono text-muted-foreground">
                      {deploy.commitId.slice(0, 7)}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 tabular-nums",
                        deploy.status === "deployed" ? "text-muted-foreground" : "text-destructive",
                      )}
                    >
                      {deploy.status === "deployed" ? "" : `${deploy.status} `}
                      {deploy.finishedAt === undefined
                        ? ""
                        : formatRelativeTimeLabel(deploy.finishedAt)}
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
      {slipJayStatus !== null && landing !== null ? (
        <SlipJayLandingLogDialog
          environmentId={environmentId}
          cwd={slipJayStatus.cwd}
          landing={landing}
          open={logOpen}
          onOpenChange={setLogOpen}
        />
      ) : null}
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

const TAG_TRIGGER =
  "-ms-1 flex min-w-0 self-stretch cursor-pointer items-center gap-2 rounded-sm px-1 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring";

/** How the thread's landing reads: the runner's row adds its queue place and timing. */
function useThreadLanding(
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
 * The thread's landing as the tag: a ticket whose stub carries the Spec, linked to Forge,
 * and whose body opens the popover. A failed landing offers its log and a fix in place.
 */
function ThreadLandingTag({
  environmentId,
  threadRef,
  status,
  landing,
  overview,
  others,
  onLog,
  onFix,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  status: SlipJayCheckoutStatus;
  landing: ShownLanding;
  overview: SlipJayRunnerOverview | null;
  others: number;
  onLog: () => void;
  onFix: () => void;
}) {
  const { chip, spec } = useThreadLanding(threadRef, status, landing, overview);
  const progress = resolveSlipJayStageProgress(landing);
  return (
    <SlipJayTicket
      tone={chip.tone}
      // Keyed by operation, so a landing seen on screen tears as it lands, and one
      // already landed when shown starts torn.
      torn={landing.status === "landed"}
      className="h-7 shrink-0 text-xs [-webkit-app-region:no-drag]"
      stub={
        <>
          <SlipJayMark />
          {spec === null ? null : <SlipJaySpecLink spec={spec} />}
        </>
      }
    >
      <PopoverTrigger
        render={
          <button type="button" className={TAG_TRIGGER} aria-label={`SlipJay: ${chip.label}`} />
        }
      >
        {spec?.title ? (
          <span className="min-w-0 max-w-48 truncate font-medium max-lg:hidden">{spec.title}</span>
        ) : null}
        <span
          role="status"
          className={cn(
            "shrink-0 font-mono",
            chip.tone === "failed" && "text-destructive",
            chip.tone === "landed" && "text-slipjay-mint-strong dark:text-slipjay-mint",
          )}
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
        {others > 0 ? <OthersCount count={others} /> : null}
      </PopoverTrigger>
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

/** Other open operations on the runner, beside the one the tag names. */
function OthersCount({ count }: { count: number }) {
  return (
    <span
      aria-label={`${count} more on the runner`}
      className="shrink-0 rounded-full bg-muted px-1.5 font-mono text-2xs text-muted-foreground tabular-nums"
    >
      +{count}
    </span>
  );
}

/** The thread's landing in full, pinned above the lanes, with everything it offers. */
function ThreadLandingSection({
  environmentId,
  threadRef,
  status,
  landing,
  overview,
  onLog,
  onFix,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  status: SlipJayCheckoutStatus;
  landing: ShownLanding;
  overview: SlipJayRunnerOverview | null;
  onLog: () => void;
  onFix: () => void;
}) {
  const { now, chip, spec } = useThreadLanding(threadRef, status, landing, overview);
  return (
    <SlipJayLandingDetails
      environmentId={environmentId}
      cwd={status.cwd}
      landing={landing}
      spec={spec}
      label={[chip.label, chip.detail, chip.elapsed].filter((part) => part !== null).join(" · ")}
      now={now}
      actions={
        <>
          {chip.tone === "waiting" ? (
            <SlipJayCancelButton environmentId={environmentId} operationId={landing.operationId} />
          ) : null}
          <Button size="xs" variant="ghost" onClick={onLog}>
            Log
          </Button>
          {chip.tone === "failed" ? (
            <Button size="xs" variant="outline" onClick={onFix}>
              Ask agent to fix
            </Button>
          ) : null}
          {landing.status === "active" ? null : (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => dismissLanding(environmentId, landing.operationId)}
            >
              Dismiss
            </Button>
          )}
        </>
      }
    />
  );
}

/**
 * What the runner is doing when the thread has no landing of its own: the running landing
 * by its Spec and stage, or a running deploy, and how many more are open.
 */
function RunnerTag({
  environmentId,
  threadRef,
  summary,
  threadsByWorkspace,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  summary: NonNullable<ReturnType<typeof resolveSlipJayRunnerSummary>>;
  threadsByWorkspace: ReadonlyMap<string, { id: ThreadId; title: string }>;
}) {
  const lead = summary.lead;
  const leadLanding = lead?.kind === "landing" ? lead : null;
  // Before SlipJay 3.40 an operation carries no Spec, so name it by its submitting thread's.
  const submitter =
    leadLanding?.workspaceName === undefined
      ? undefined
      : threadsByWorkspace.get(leadLanding.workspaceName);
  const spec = useSlipJaySpec(
    submitter === undefined ? null : scopeThreadRef(environmentId, submitter.id),
    leadLanding?.spec,
    threadRef,
  );
  if (summary.tone === "idle") {
    return (
      <PopoverTrigger
        render={
          <button
            type="button"
            className="shrink-0 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-ring [-webkit-app-region:no-drag]"
            aria-label="SlipJay: idle"
          />
        }
      >
        <SlipJayTicket
          solid
          tone="waiting"
          className="h-7 text-xs"
          stub={<SlipJayMark className="size-4" />}
        >
          {null}
        </SlipJayTicket>
      </PopoverTrigger>
    );
  }
  const stage = SLIPJAY_LANDING_STAGES.indexOf(
    leadLanding?.stage as (typeof SLIPJAY_LANDING_STAGES)[number],
  );
  const attention = summary.tone === "attention";
  return (
    <SlipJayTicket
      tone={lead !== null && !attention ? "running" : "waiting"}
      className="h-7 shrink-0 text-xs [-webkit-app-region:no-drag]"
      stub={
        <>
          <SlipJayMark />
          {spec === null || attention ? null : <SlipJaySpecLink spec={spec} />}
        </>
      }
    >
      <PopoverTrigger
        render={
          <button type="button" className={TAG_TRIGGER} aria-label={`SlipJay: ${summary.label}`} />
        }
      >
        {attention ? (
          <span
            className={cn("shrink-0 font-mono", summary.label === "reconnecting" && "text-warning")}
          >
            {summary.label}
          </span>
        ) : lead === null ? (
          <span className="shrink-0 font-mono">{summary.others} queued</span>
        ) : leadLanding !== null ? (
          <>
            <span className="shrink-0 font-mono">{leadLanding.stage}</span>
            {stage >= 0 ? (
              <SlipJayStageDots tone="running" completed={stage} current={stage} />
            ) : null}
          </>
        ) : (
          <span className="min-w-0 truncate font-mono">
            {lead.kind === "deploy"
              ? `deploying to ${lead.environment ?? "an environment"}`
              : resolveSlipJayOperationLabel(lead)}
          </span>
        )}
        {(lead !== null || attention) && summary.others > 0 ? (
          <OthersCount count={summary.others} />
        ) : null}
      </PopoverTrigger>
    </SlipJayTicket>
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
  lookupRef,
  operations,
  threadsByWorkspace,
  showRepository,
  open,
  onOpenThread,
}: {
  title: string;
  environmentId: EnvironmentId;
  lookupRef: ScopedThreadRef;
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
            lookupRef={lookupRef}
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
 * One operation as a ticket. A landing leads with the Spec it delivers, linked to Forge:
 * the one SlipJay recorded, else the submitting thread's Forge link. Its title opens the
 * submitting thread; without a Spec it shows the thread's title.
 */
function RunnerOperationRow({
  environmentId,
  lookupRef,
  operation,
  thread,
  showRepository,
  now,
  onOpenThread,
}: {
  environmentId: EnvironmentId;
  lookupRef: ScopedThreadRef;
  operation: SlipJayRunnerOperation;
  thread: { id: ThreadId; title: string } | undefined;
  showRepository: boolean;
  now: number;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const isLanding = operation.kind === "landing";
  const spec = useSlipJaySpec(
    isLanding && thread !== undefined ? scopeThreadRef(environmentId, thread.id) : null,
    isLanding ? operation.spec : undefined,
    lookupRef,
  );
  const running = operation.status === "running";
  const stage = SLIPJAY_LANDING_STAGES.indexOf(
    operation.stage as (typeof SLIPJAY_LANDING_STAGES)[number],
  );
  const title = isLanding
    ? (spec?.title ?? thread?.title ?? resolveSlipJayOperationLabel(operation))
    : resolveSlipJayOperationLabel(operation);
  const elapsed = resolveSlipJayOperationElapsed(operation, !running, now);
  const detail = [
    resolveSlipJayQueueLabel(operation) ?? operation.stage,
    ...(elapsed === null ? [] : [elapsed]),
  ].join(" · ");
  const source = [
    ...(thread === undefined && operation.workspaceName === undefined
      ? [operation.submittedBy]
      : []),
    ...(showRepository ? [repositoryName(operation.repo)] : []),
  ].join(" · ");
  const heading = (
    <span className="flex min-w-0 items-center gap-1.5">
      {spec === null ? null : (
        <SlipJaySpecLink spec={spec} className="shrink-0 font-mono text-slipjay text-xs" />
      )}
      {thread === undefined ? (
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      ) : (
        <button
          type="button"
          className="min-w-0 flex-1 cursor-pointer truncate rounded-sm text-start font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => onOpenThread(thread.id)}
        >
          {title}
        </button>
      )}
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
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 pe-2.5">
        {heading}
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          {isLanding && stage >= 0 ? (
            <SlipJayStageDots tone="running" completed={stage} current={stage} />
          ) : null}
          <span className="shrink-0 font-mono tabular-nums">{detail}</span>
          {source === "" ? null : <span className="ms-auto min-w-0 truncate">{source}</span>}
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
