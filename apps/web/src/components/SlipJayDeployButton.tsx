import { formatSlipJayDuration } from "@t3tools/client-runtime/slipjay-checkout";
import type { EnvironmentId } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import {
  resolveProductionDeploys,
  resolveProductionLine,
  resolveReleaseWaiting,
} from "./SlipJayBox.logic";
import { useNow } from "./SlipJayTicket";

/**
 * Shown in the header only while a deploy to production is running, apart from the SlipJay tag:
 * the commit and how long it has run, and the release's steps in a popover. Controls for the
 * release stay in the SlipJay box.
 */
export function SlipJayDeployButton({ environmentId }: { environmentId: EnvironmentId }) {
  const { data: overview } = useEnvironmentQuery(
    vcsEnvironment.slipJayRunner({ environmentId, input: {} }),
  );
  const deploys = overview == null ? [] : resolveProductionDeploys(overview);
  const now = useNow(deploys.length > 0);
  const [deploy] = deploys;
  if (overview == null || deploy === undefined) return null;
  const elapsed =
    deploy.startedAt === null ? null : formatSlipJayDuration(now - Date.parse(deploy.startedAt));
  const sha = deploy.commitId.slice(0, 7);
  const releasing = overview.repositories.filter(
    (repository) => repository.release !== null && deploys.some((d) => d.repo === repository.repo),
  );
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            className="shrink-0 [-webkit-app-region:no-drag]"
            aria-label={`Releasing ${sha} to production`}
          />
        }
      >
        <Spinner />
        <span className="font-mono max-sm:hidden">Releasing {sha}</span>
        {elapsed === null ? null : <span className="font-mono tabular-nums">{elapsed}</span>}
        {deploys.length > 1 ? (
          <span className="font-mono text-muted-foreground">+{deploys.length - 1}</span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="lg" padding="compact" className="w-[26rem]">
        <div className="flex flex-col gap-3 text-sm">
          {releasing.map((repository) => {
            const release = repository.release;
            if (release === null) return null;
            const waiting = resolveReleaseWaiting(release);
            const production = resolveProductionLine(release, now);
            return (
              <section key={repository.repo} className="flex flex-col gap-1 px-1 text-xs">
                <span className="font-mono font-semibold text-2xs text-muted-foreground uppercase tracking-widest">
                  {repository.repo.slice(repository.repo.indexOf("/") + 1)} → Production
                </span>
                <span>{waiting.text}</span>
                <span className="text-muted-foreground">{production.text}</span>
                {production.note === null ? null : (
                  <span className="text-2xs text-muted-foreground">{production.note}</span>
                )}
              </section>
            );
          })}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
