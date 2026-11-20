import type { ChampionRuntimeState, ChampionSummary, EnvironmentId } from "@t3tools/contracts";
import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

import { AgentRoleChip } from "../AgentRoleChip";
import { ScheduledRelativeLabel, scheduleLabel } from "../scheduled/scheduledTaskParts";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { ChampionModelStrip } from "./ChampionModels";

/** One line showing when this champion runs and which models its next check and advice use. */
export function ChampionRunStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly champion: ChampionSummary;
  readonly runtimeState: ChampionRuntimeState | null;
  readonly modelControls?: ReactNode;
  readonly projectTitle: string | null;
  readonly machineLabel: string | null;
}) {
  const { champion, environmentId } = props;
  const active = champion.lifecycle === "active";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
      <span>
        <span className="text-muted-foreground">Runs </span>
        {champion.lifecycle === "retired"
          ? "never (retired)"
          : `${scheduleLabel(champion.schedule).toLowerCase()}${active ? "" : " when on"}`}
        {active && champion.nextCheckAt !== null ? (
          <span className="text-muted-foreground">
            {" · next "}
            <ScheduledRelativeLabel value={champion.nextCheckAt} />
          </span>
        ) : null}
      </span>
      <ChampionModelStrip
        environmentId={environmentId}
        champion={champion}
        changeControl={props.modelControls}
      />
      <span className="text-muted-foreground">
        {props.projectTitle ?? "Project not loaded"}
        {props.machineLabel === null ? "" : ` on ${props.machineLabel}`}
      </span>
    </div>
  );
}

/** What every champion does, explained once for the whole Champions section. */
export function HowChampionsWorkDialog() {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button size="xs" variant="ghost-muted">
            <InfoIcon className="size-3" />
            How it works
          </Button>
        }
      />
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>How champions work</DialogTitle>
          <DialogDescription>
            A champion looks after one goal for a project and keeps working towards it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted-foreground">Checks</dt>
            <dd>
              On its schedule, or when you press Check now, it measures each metric and asks what
              most holds back its goal. Checks run on the checks model you choose under Champion
              models, with an optional backup.
            </dd>
            <dt className="text-muted-foreground">Advice and setup</dt>
            <dd>
              Choosing metrics and diagnosing a problem use the advice model. One Champion can have
              its own model for checks, advice or both. When a model reaches its usage limit the
              backup takes over; when neither can run, the check is skipped, the page says why and
              when each model returns, and the next check runs on time.
            </dd>
            <dt className="text-muted-foreground">Problems</dt>
            <dd>
              Small fixes go to a worker in its own workspace and land through SlipJay. Larger work
              becomes a Spec. Anything that needs your judgement comes to you as a decision with its
              proposed answer.
            </dd>
            <dt className="text-muted-foreground">Paused</dt>
            <dd>
              A paused champion skips its schedule. Check now still measures and reports, but it
              starts no fixes.
            </dd>
            <dt className="text-muted-foreground">Metrics</dt>
            <dd>
              Metrics are its instruments, not its goal. When they can't show progress, it changes
              them itself, after checking each new one reads a value, and they show as new here. You
              can ask for a change from any thread. Fix with a lead starts a{" "}
              <AgentRoleChip role="lead" /> thread to rework them.
            </dd>
          </dl>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
