import { useAtomValue } from "@effect/atom-react";
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
import { RocketIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { formatElapsedDurationLabel } from "~/timestampFormat";
import {
  resolveFailedPromotions,
  resolveProductionAges,
  resolveReleasesInFlight,
  resolveProductionLine,
  resolveReleaseRow,
} from "./SlipJayBox.logic";
import { TONE_TEXT } from "./SlipJayRunnerControl";
import { useNow } from "./SlipJayTicket";

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
  if (overview == null) return null;
  const releasing = overview.repositories.filter((repository) => repository.release !== null);
  if (releasing.length === 0 && !deploying) return null;
  const ages = resolveProductionAges(overview);
  const [deploy] = deploys;
  // Before the plan names a commit the release has none to show.
  const sha =
    deploy === undefined || deploy.commitId === "" ? "" : ` ${deploy.commitId.slice(0, 7)}`;
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
            variant="outline"
            className="shrink-0 [-webkit-app-region:no-drag]"
            aria-label={
              deploy === undefined ? "Production releases" : `Releasing${sha} to production`
            }
          />
        }
      >
        {deploy !== undefined ? (
          <>
            <Spinner />
            <span className="font-mono max-sm:hidden">Releasing{sha}</span>
            {deploy.startedAt === null ? null : (
              <span className="font-mono tabular-nums">
                {formatSlipJayDuration(now - Date.parse(deploy.startedAt))}
              </span>
            )}
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
              promotion={
                promotions?.find((promotion) => promotion.repo === repository.repo) ?? null
              }
              open={open}
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
  promotion,
  open,
}: {
  environmentId: EnvironmentId;
  repository: SlipJayRunnerRepository;
  promotion: VcsSlipJayPromotion | null;
  open: boolean;
}) {
  const now = useNow(open);
  const canRelease = useAtomValue(vcsEnvironment.slipJayPromote.permissionAtom(environmentId));
  const promote = useAtomCommand(vcsEnvironment.slipJayPromote, { reportFailure: false });
  const dismiss = useAtomCommand(vcsEnvironment.slipJayDismissPromotion, { reportFailure: false });
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
  const detail = requestError ?? row.detail;
  return (
    <div className="flex flex-col gap-0.5 px-1 text-xs">
      <div className="flex min-h-6 min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-medium text-sm">{name}</span>
        <span className="ms-auto flex shrink-0 items-center gap-1">
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
