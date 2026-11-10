import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { formatSlipJayDuration } from "@t3tools/client-runtime/slipjay-checkout";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  SlipJayRunnerRepository,
  VcsSlipJayPromotion,
} from "@t3tools/contracts";
import { CheckIcon, CircleIcon, ClockIcon, RocketIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button, type ButtonVariant } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { formatElapsedDurationLabel } from "~/timestampFormat";
import {
  RELEASE_PHASE_LABEL,
  RELEASE_PHASE_SHORT,
  advanceReleaseClock,
  releaseClockKey,
  resolveFailedPromotions,
  resolveProductionAges,
  resolveReleasesInFlight,
  resolveProductionLine,
  resolveReleaseFixPrompt,
  resolveReleaseProgress,
  resolveReleaseRow,
  resolveReleaseStepTimes,
  type ReleasePhase,
  type ReleasePhaseClock,
  type ReleaseProgress,
} from "./SlipJayBox.logic";
import { TONE_TEXT } from "./SlipJayRunnerControl";
import { useNow } from "./SlipJayTicket";

/** The button takes its colour from the phase a release is in. */
const PHASE_VARIANT: Record<ReleasePhase, ButtonVariant> = {
  images: "info-outline",
  audit: "warning-outline",
  verification: "slipjay-outline",
  deploy: "success-outline",
};

const repositoryName = (repo: string) => repo.slice(repo.indexOf("/") + 1);

/**
 * Production in the header, apart from the SlipJay tag, which is the landing runner: how long
 * ago the last release went live and, while a deploy runs, its commit and time. Its popover is
 * where a release is started, retried or dismissed.
 */
export function ReleaseButton({ environmentId }: { environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  const { data: overview } = useEnvironmentQuery(
    vcsEnvironment.slipJayRunner({ environmentId, input: {} }),
  );
  const { data: promotions } = useEnvironmentQuery(
    vcsEnvironment.slipJayPromotions({ environmentId, input: {} }),
  );
  const deploys = overview == null ? [] : resolveReleasesInFlight(overview, promotions);
  const deploying = deploys.length > 0;
  // A minute is the finest an age at rest shows; a running deploy counts seconds.
  const now = useNow(overview != null, deploying ? 1000 : 30_000);
  const [clock, setClock] = useState<ReleasePhaseClock>({});
  // Notes when each phase was first seen, which the runner does not report once it is over.
  const seenClock =
    overview == null
      ? clock
      : overview.repositories.reduce(
          (next, repository) =>
            repository.release === null
              ? next
              : advanceReleaseClock(
                  next,
                  releaseClockKey(repository.repo, repository.release.candidate?.commitId ?? null),
                  resolveReleaseProgress(repository.repo, repository.release, overview),
                  now,
                ),
          clock,
        );
  if (seenClock !== clock) setClock(seenClock);
  if (overview == null) return null;
  const releasing = overview.repositories.filter((repository) => repository.release !== null);
  if (releasing.length === 0 && !deploying) return null;
  const ages = resolveProductionAges(overview);
  const [deploy] = deploys;
  const progressOf = (repo: string): { progress: ReleaseProgress; key: string } | null => {
    const release = overview.repositories.find((repository) => repository.repo === repo)?.release;
    return release == null
      ? null
      : {
          progress: resolveReleaseProgress(repo, release, overview),
          key: releaseClockKey(repo, release.candidate?.commitId ?? null),
        };
  };
  const lead = deploy === undefined ? null : progressOf(deploy.repo);
  const phase = lead?.progress.phase ?? null;
  const starts = lead === null ? [] : Object.values(clock[lead.key] ?? {});
  const began = Math.min(
    ...starts,
    deploy?.startedAt == null ? Number.POSITIVE_INFINITY : Date.parse(deploy.startedAt),
  );
  const elapsed = Number.isFinite(began) ? formatSlipJayDuration(now - began) : null;
  const failed =
    !deploying &&
    (resolveFailedPromotions(overview, promotions).length > 0 || ages.some((age) => age.failed));
  const unhealthy = !deploying && ages.some((age) => age.healthy === false);
  const ageLabel = (deployedAt: string) => formatElapsedDurationLabel(deployedAt, now);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant={
              deploy === undefined
                ? failed
                  ? "destructive-outline"
                  : "outline"
                : lead?.progress.state === "bad"
                  ? "destructive-outline"
                  : lead?.progress.state === "waiting" || phase === null
                    ? "warning-outline"
                    : PHASE_VARIANT[phase]
            }
            className="shrink-0 [-webkit-app-region:no-drag]"
            aria-label={
              deploy === undefined
                ? "Production releases"
                : `Releasing to production${phase === null ? "" : `, ${RELEASE_PHASE_LABEL[phase]}`}${elapsed === null ? "" : `, ${elapsed}`}`
            }
          />
        }
      >
        {deploy !== undefined ? (
          <>
            <Spinner />
            <span className="font-mono max-sm:hidden">
              {phase === null ? "Releasing" : RELEASE_PHASE_SHORT[phase]}
            </span>
            {elapsed === null ? null : <span className="font-mono tabular-nums">{elapsed}</span>}
            {deploys.length > 1 ? (
              <span className="font-mono text-muted-foreground">+{deploys.length - 1}</span>
            ) : null}
          </>
        ) : (
          <>
            <RocketIcon aria-hidden />
            <span
              className={cn(
                "font-mono tabular-nums",
                (failed || unhealthy) && "text-destructive-foreground",
              )}
            >
              {failed
                ? "Release failed"
                : ages.length === 0
                  ? "Production"
                  : ages.length === 1
                    ? `Released ${ageLabel(ages[0]!.deployedAt)} ago`
                    : ages
                        .map((age) => `${repositoryName(age.repo)} ${ageLabel(age.deployedAt)}`)
                        .join(" · ")}
            </span>
          </>
        )}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="lg" padding="compact" className="w-[26rem]">
        <div className="flex flex-col gap-3 text-sm">
          {releasing.map((repository) => (
            <ReleaseRow
              key={repository.repo}
              environmentId={environmentId}
              repository={repository}
              progress={progressOf(repository.repo)}
              clock={clock}
              promotion={
                promotions?.find((promotion) => promotion.repo === repository.repo) ?? null
              }
              open={open}
              onClose={() => setOpen(false)}
            />
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * One repository's release, in two lines: what is happening and what production runs. A press
 * starts it; the server carries it through and reports back here, so there is nothing to wait on.
 */
function ReleaseRow({
  environmentId,
  repository,
  progress,
  clock,
  promotion,
  open,
  onClose,
}: {
  environmentId: EnvironmentId;
  repository: SlipJayRunnerRepository;
  progress: { progress: ReleaseProgress; key: string } | null;
  clock: ReleasePhaseClock;
  promotion: VcsSlipJayPromotion | null;
  open: boolean;
  onClose: () => void;
}) {
  const now = useNow(open);
  const canRelease = useAtomValue(vcsEnvironment.slipJayPromote.permissionAtom(environmentId));
  const promote = useAtomCommand(vcsEnvironment.slipJayPromote, { reportFailure: false });
  const dismiss = useAtomCommand(vcsEnvironment.slipJayDismissPromotion, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();
  const [requestError, setRequestError] = useState<string | null>(null);
  // A repository's apps ship together, so the row names every local project in it.
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      project.repositoryIdentity != null &&
      `${project.repositoryIdentity.owner}/${project.repositoryIdentity.name}`.toLowerCase() ===
        repository.repo.toLowerCase(),
  );
  const checkout = projects[0]?.workspaceRoot;
  const release = repository.release;
  if (release === null) return null;
  const row = resolveReleaseRow(release, promotion);
  const production = resolveProductionLine(release, now);
  const name =
    projects.length === 0
      ? repositoryName(repository.repo)
      : projects.map((project) => project.title).join(" + ");
  const start = async () => {
    if (checkout === undefined) return;
    setRequestError(null);
    const result = await promote({
      environmentId,
      input: { cwd: checkout, repo: repository.repo },
    });
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    setRequestError(error instanceof Error ? error.message : "The release could not be started.");
  };
  const fixWithAgent = async () => {
    const project = projects[0];
    if (project === undefined) return;
    onClose();
    try {
      await handleNewThread(scopeProjectRef(environmentId, project.id), {
        prompt: resolveReleaseFixPrompt({
          name,
          candidate: promotion?.candidate ?? null,
          reason: promotion?.reason ?? null,
        }),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not create thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };
  const detail = requestError ?? row.detail;
  return (
    <div className="flex flex-col gap-0.5 px-1 text-xs">
      <div className="flex min-h-6 min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-medium text-sm">{name}</span>
        <span className="ms-auto flex shrink-0 items-center gap-1">
          {row.action === "retry" && projects.length > 0 ? (
            <Button size="xs" variant="ghost" onClick={() => void fixWithAgent()}>
              Fix with agent
            </Button>
          ) : null}
          {row.action === "retry" ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void dismiss({ environmentId, input: { repo: repository.repo } }).then(() =>
                  setRequestError(null),
                )
              }
            >
              Dismiss
            </Button>
          ) : null}
          {row.action === "releasing" ? (
            <Button size="xs" variant="outline" disabled>
              <Spinner />
              Releasing
            </Button>
          ) : (row.action === "release" || row.action === "retry") &&
            canRelease &&
            checkout !== undefined ? (
            <Button size="xs" variant="outline" onClick={() => void start()}>
              {row.action === "retry" ? "Try again" : "Release"}
            </Button>
          ) : null}
        </span>
      </div>
      <span className={TONE_TEXT[requestError === null ? row.tone : "bad"]}>{row.text}</span>
      {progress === null || progress.progress.phase === null ? null : (
        <ReleaseSteps progress={progress.progress} starts={clock[progress.key]} now={now} />
      )}
      {detail === null ? null : (
        <p
          className={cn(
            "m-0 whitespace-pre-wrap break-words text-2xs",
            requestError !== null || row.tone === "bad"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {detail}
        </p>
      )}
      <span className="text-muted-foreground">{production.text}</span>
      {production.note === null ? null : (
        <span className="text-2xs text-muted-foreground">{production.note}</span>
      )}
    </div>
  );
}

const STEP_MARK = {
  done: <CheckIcon className="size-3.5 text-success-foreground" aria-label="Done" />,
  current: <Spinner />,
  waiting: <ClockIcon className="size-3.5 text-warning-foreground" aria-label="Waiting" />,
  bad: <XIcon className="size-3.5 text-destructive-foreground" aria-label="Failed" />,
  pending: <CircleIcon className="size-3 text-muted-foreground/60" aria-label="Not started" />,
} as const;

/** The release's phases in order, which one it is in, and how long each took or has taken. */
function ReleaseSteps({
  progress,
  starts,
  now,
}: {
  progress: ReleaseProgress;
  starts: ReleasePhaseClock[string] | undefined;
  now: number;
}) {
  const times = resolveReleaseStepTimes(progress.steps, starts, now);
  const { operation } = progress;
  const stageSince =
    operation?.stageStartedAt === undefined ? null : now - Date.parse(operation.stageStartedAt);
  return (
    <ol className="m-0 flex list-none flex-col gap-1 p-0 pt-1.5">
      {progress.steps.map((step, index) => {
        const time = times[index];
        const current = step.state === "current" || step.state === "bad";
        return (
          <li key={step.phase} className="flex flex-col">
            <span className="flex items-center gap-2">
              <span className="flex size-4 shrink-0 items-center justify-center">
                {STEP_MARK[step.state]}
              </span>
              <span
                className={cn(
                  "min-w-0 truncate",
                  step.state === "pending" && "text-muted-foreground",
                  current && "font-medium",
                  step.state === "bad" && "text-destructive-foreground",
                )}
              >
                {RELEASE_PHASE_LABEL[step.phase]}
              </span>
              <span className="ms-auto font-mono tabular-nums text-muted-foreground">
                {time === null || time === undefined ? "" : formatSlipJayDuration(time)}
              </span>
            </span>
            {step.state === "current" && operation !== null ? (
              <span className="ps-6 text-2xs text-muted-foreground">
                {operation.stage}
                {stageSince === null || Number.isNaN(stageSince)
                  ? ""
                  : ` · ${formatSlipJayDuration(stageSince)}`}
                {operation.stageMedianMs === undefined
                  ? ""
                  : ` · usually ${formatSlipJayDuration(operation.stageMedianMs)}`}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
