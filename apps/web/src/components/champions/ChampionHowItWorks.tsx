import type { ChampionRuntimeState, ChampionSummary, EnvironmentId } from "@t3tools/contracts";
import { T, Var } from "gt-react";
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

/** One line showing when this champion runs and which models its next readings and review use. */
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
  const schedule = scheduleLabel(champion.schedule).toLowerCase();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
      <span>
        {champion.lifecycle === "retired" ? (
          <T>
            <span className="text-muted-foreground">Runs</span> never (retired)
          </T>
        ) : active ? (
          <T>
            <span className="text-muted-foreground">Runs</span> <Var>{schedule}</Var>
          </T>
        ) : (
          <T>
            <span className="text-muted-foreground">Runs</span> <Var>{schedule}</Var> when on
          </T>
        )}
        {active && champion.nextCheckAt !== null ? (
          <span className="text-muted-foreground">
            <T>
              {" "}
              · next{" "}
              <Var>
                <ScheduledRelativeLabel value={champion.nextCheckAt} />
              </Var>
            </T>
          </span>
        ) : null}
      </span>
      {active && champion.nextReviewAt != null ? (
        <span>
          <T>
            <span className="text-muted-foreground">Next goal review</span>{" "}
            <Var>
              <ScheduledRelativeLabel value={champion.nextReviewAt} />
            </Var>
          </T>
        </span>
      ) : null}
      <ChampionModelStrip
        environmentId={environmentId}
        champion={champion}
        changeControl={props.modelControls}
      />
      <span className="text-muted-foreground">
        {props.projectTitle === null ? (
          props.machineLabel === null ? (
            <T>Project not loaded</T>
          ) : (
            <T>
              Project not loaded on <Var>{props.machineLabel}</Var>
            </T>
          )
        ) : props.machineLabel === null ? (
          props.projectTitle
        ) : (
          <T>
            <Var>{props.projectTitle}</Var> on <Var>{props.machineLabel}</Var>
          </T>
        )}
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
            <T>How it works</T>
          </Button>
        }
      />
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <T>How champions work</T>
          </DialogTitle>
          <DialogDescription>
            <T>A champion owns one goal for a project. It observes and scores; it never repairs.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted-foreground">
              <T>Readings</T>
            </dt>
            <dd>
              <T>
                On its schedule, or when you press Check now, the server reads every scripted
                metric. The readings model wakes only to measure what no script can. Readings run on
                the checks model you choose under Champion models, with an optional backup.
              </T>
            </dd>
            <dt className="text-muted-foreground">
              <T>Goal reviews</T>
            </dt>
            <dd>
              <T>
                Weekly by default, a goal review on the stronger model reads the goal, the readings,
                recent changes and the code, scores the goal from 0 to 10 and raises findings. The
                same model sets up metrics. When a model reaches its usage limit the backup takes
                over; when neither can run, the run is skipped and the page says why.
              </T>
            </dd>
            <dt className="text-muted-foreground">
              <T>Cases</T>
            </dt>
            <dd>
              <T>
                Every finding that needs work opens a case in your Inbox, with a brief an agent can
                act on. While you are attended a case waits for you to start it; while you are away,
                and for alarms, it starts on its own.
              </T>
            </dd>
            <dt className="text-muted-foreground">
              <T>Paused</T>
            </dt>
            <dd>
              <T>A paused champion skips its schedule. Check now still measures and reports.</T>
            </dd>
            <dt className="text-muted-foreground">
              <T>Metrics</T>
            </dt>
            <dd>
              <T>
                Metrics are its instruments, not its goal. When they can&apos;t show progress, it
                changes them itself, after checking each new one reads a value, and they show as new
                here. You can ask for a change from any thread. Fix with a lead starts a{" "}
                <AgentRoleChip role="lead" /> thread to rework them.
              </T>
            </dd>
          </dl>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
