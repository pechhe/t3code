import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, VcsSlipJayPromotionPlan } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const fileName = (path: string) => path.split("/").at(-1) ?? path;

/**
 * A SlipJay project's release: `slipjay promote`'s plan for the staging candidate, and
 * the owner's approval of exactly that candidate. Promoting is a person's decision, so
 * the plan is read fresh each time the dialog opens and the button names the commit.
 */
export function SlipJayReleaseDialog({
  environmentId,
  project,
  open,
  onOpenChange,
}: {
  environmentId: EnvironmentId;
  project: { cwd: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const planQuery = useEnvironmentQuery(
    open
      ? vcsEnvironment.slipJayPromotionPlan({ environmentId, input: { cwd: project.cwd } })
      : null,
  );
  // Each opening reads a fresh plan; until it arrives the previous one is not approvable.
  const plan = planQuery.isPending ? null : planQuery.data;
  const canPromote = useAtomValue(vcsEnvironment.slipJayPromote.permissionAtom(environmentId));
  const promote = useAtomCommand(vcsEnvironment.slipJayPromote, { reportFailure: false });
  const [promoting, setPromoting] = useState(false);

  const onPromote = async (candidate: string) => {
    setPromoting(true);
    const result = await promote({ environmentId, input: { cwd: project.cwd, candidate } });
    setPromoting(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not promote",
        description: error instanceof Error ? error.message : "SlipJay could not be run.",
      });
      return;
    }
    const { released, status, messages } = result.value;
    toastManager.add({
      type: released ? "success" : "error",
      title: released ? `Released ${candidate.slice(0, 8)} to production` : `Promotion ${status}`,
      ...(messages.length === 0 ? {} : { description: messages.join("\n") }),
    });
    if (released) onOpenChange(false);
  };

  const candidate = plan?.status === "planned" ? plan.candidate : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Release {project.name}</DialogTitle>
          <DialogDescription>
            {plan === null ? (planQuery.error ?? "Planning the promotion…") : planDescription(plan)}
          </DialogDescription>
        </DialogHeader>
        {plan !== null && plan.status === "planned" ? (
          <DialogPanel>
            <div className="flex flex-col gap-4 text-sm">
              <ReleaseSection title={`Changes (${plan.subjects.length})`}>
                <ul className="flex max-h-48 flex-col gap-1 overflow-auto">
                  {plan.subjects.map((subject) => (
                    <li key={subject} className="text-muted-foreground">
                      {subject}
                    </li>
                  ))}
                </ul>
              </ReleaseSection>
              {migrationFiles(plan).length > 0 ? (
                <ReleaseSection title="Production migrations">
                  <ul className="flex flex-col gap-1">
                    {migrationFiles(plan).map((path) => (
                      <li key={path} className="flex items-baseline gap-2 font-mono text-xs">
                        {fileName(path)}
                        {plan.nonAdditiveMigrations.includes(path) ? (
                          <span className="font-sans text-warning">not additive</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {plan.nonAdditiveMigrations.length > 0 ? (
                    <p className="text-warning text-xs">
                      If production fails its health check after a migration that is not additive,
                      SlipJay does not roll it back automatically.
                    </p>
                  ) : null}
                </ReleaseSection>
              ) : null}
              {plan.halfBuiltSpecs.length > 0 ? (
                <ReleaseSection title="Partly delivered Specs">
                  <ul className="flex flex-col gap-1">
                    {plan.halfBuiltSpecs.map((spec) => (
                      <li key={spec.number} className="text-muted-foreground">
                        <a
                          href={spec.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-foreground hover:underline"
                        >
                          #{spec.number}
                        </a>{" "}
                        {spec.title} · {spec.closedTickets} of {spec.totalTickets} Tickets closed
                      </li>
                    ))}
                  </ul>
                </ReleaseSection>
              ) : null}
              {plan.checks.length > 0 ? (
                <ReleaseSection title="Release checks">
                  <p className="font-mono text-muted-foreground text-xs">
                    {plan.checks.join(" · ")}
                  </p>
                </ReleaseSection>
              ) : null}
            </div>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {promoting ? "Close" : "Not now"}
          </Button>
          {candidate !== undefined ? (
            <Button disabled={!canPromote || promoting} onClick={() => void onPromote(candidate)}>
              {promoting ? "Promoting…" : `Promote ${candidate.slice(0, 8)}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The migrations a person reads: SQL files, and any other file SlipJay flags as not additive. */
function migrationFiles(plan: VcsSlipJayPromotionPlan): ReadonlyArray<string> {
  return plan.migrationArtifacts.filter(
    (path) => path.endsWith(".sql") || plan.nonAdditiveMigrations.includes(path),
  );
}

function planDescription(plan: VcsSlipJayPromotionPlan): string {
  const branches =
    plan.integrationBranch !== undefined && plan.releaseBranch !== undefined
      ? `${plan.integrationBranch} to ${plan.releaseBranch}`
      : "the integration branch";
  switch (plan.status) {
    case "planned":
      return `Promotes ${branches} at the commit staging deployed, ${plan.candidate?.slice(0, 8) ?? ""}. The runner runs the release checks, then deploys production from exactly that commit.`;
    case "up_to_date":
      return `Nothing to release: ${plan.releaseBranch ?? "the release branch"} already holds what staging deployed.`;
    default:
      return plan.reason ?? `SlipJay will not promote (${plan.status}).`;
  }
}

function ReleaseSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="font-medium text-xs">{title}</h3>
      {children}
    </section>
  );
}
