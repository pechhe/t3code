import type {
  AgentRole,
  ChampionRuntimeState,
  ChampionSummary,
  EnvironmentId,
  ModelSelection,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { InfoIcon } from "lucide-react";

import { AgentRoleChip } from "../AgentRoleChip";
import { ModelLabel } from "../ModelLabel";
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
import { championRecentRuns } from "./champions.logic";

function RoleWithModel(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly role: AgentRole | null;
  readonly selection: ModelSelection | null;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-muted-foreground">{props.label}</span>
      {props.role ? <AgentRoleChip role={props.role} /> : null}
      {props.selection ? (
        <ModelLabel
          environmentId={props.environmentId}
          instanceId={props.selection.instanceId}
          model={props.selection.model}
          className="inline-flex"
        />
      ) : null}
    </span>
  );
}

/** One line showing when this champion runs and which roles and models do its work. */
export function ChampionRunStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly champion: ChampionSummary;
  readonly runtimeState: ChampionRuntimeState | null;
  readonly projectTitle: string | null;
  readonly machineLabel: string | null;
  readonly ownerThreadExists: boolean;
}) {
  const { champion, environmentId } = props;
  const runs = props.runtimeState === null ? [] : championRecentRuns(props.runtimeState);
  const lastOf = (check: boolean) => {
    const run = runs.find((candidate) => (candidate.kind === "Check") === check);
    return run === undefined ? null : (run.actual ?? run.resolved);
  };
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
      <RoleWithModel
        environmentId={environmentId}
        label="Checks"
        role={champion.classes?.routine.role ?? null}
        selection={lastOf(true) ?? (champion.classes ? null : champion.routineModelSelection)}
      />
      <RoleWithModel
        environmentId={environmentId}
        label="Harder work"
        role={champion.classes?.setup.role ?? null}
        selection={lastOf(false) ?? (champion.classes ? null : champion.setupModelSelection)}
      />
      <span className="text-muted-foreground">
        {props.projectTitle ?? "Project not loaded"}
        {props.machineLabel === null ? "" : ` on ${props.machineLabel}`}
        {props.ownerThreadExists ? (
          <>
            {" · "}
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: champion.ownerThreadId }}
              className="underline-offset-2 hover:underline"
            >
              Working thread
            </Link>
          </>
        ) : null}
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
              most holds back its goal. Checks run on a cheap role, usually{" "}
              <AgentRoleChip role="chore-worker" />.
            </dd>
            <dt className="text-muted-foreground">Harder work</dt>
            <dd>
              Choosing metrics, researching a problem and planning larger fixes use a stronger role,
              usually <AgentRoleChip role="advisor" />. Your role policy picks each role's model, so
              changing it there changes later runs.
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
              Metrics are its instruments, not its goal. When they can't show progress, it proposes
              better ones for you to accept. Fix with a lead starts a <AgentRoleChip role="lead" />{" "}
              thread to rework them.
            </dd>
          </dl>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
