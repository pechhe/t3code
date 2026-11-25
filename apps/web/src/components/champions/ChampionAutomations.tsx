/* oxlint-disable t3code/no-untranslated-copy -- The fork-only Champions page predates the rule and has no translations yet. */
import type { ChampionId, EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";

import { useAllScheduledTasks } from "../../state/scheduledTasks";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { tasksOfChampion } from "../scheduled/scheduledTaskChampion.logic";
import {
  ScheduledRelativeLabel,
  scheduleLabel,
  statusVariant,
} from "../scheduled/scheduledTaskParts";

const STATUS_LABELS = {
  never: "Not run yet",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
} as const;

/** The scheduled tasks on this machine that name the Champion; nothing when there are none. */
export function ChampionAutomations(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: ChampionId;
}) {
  const source = useAllScheduledTasks().find(
    (candidate) => candidate.environmentId === props.environmentId,
  );
  const tasks = tasksOfChampion(source?.tasks ?? [], props.championId);
  if (tasks.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Automations">
      <div className="flex min-h-6.5 items-center">
        <h3 className="font-medium text-sm">Automations</h3>
      </div>
      <ul className="flex flex-col divide-y overflow-hidden rounded-lg border bg-card">
        {tasks.map((task) => {
          const threadId = task.lastRunThreadId ?? task.threadId;
          return (
            <li key={task.id} className="flex items-center gap-2 p-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Link
                  to="/scheduled"
                  search={{ environmentId: props.environmentId, taskId: task.id }}
                  className="truncate font-medium text-sm hover:underline"
                >
                  {task.title}
                </Link>
                <span className="truncate text-muted-foreground text-xs">
                  {scheduleLabel(task.schedule)}
                  {!task.enabled ? (
                    " · paused"
                  ) : task.nextRunAt !== null ? (
                    <>
                      {" · next "}
                      <ScheduledRelativeLabel value={task.nextRunAt} />
                    </>
                  ) : null}
                </span>
              </div>
              <Badge variant={statusVariant(task.lastRunStatus)}>
                {STATUS_LABELS[task.lastRunStatus]}
              </Badge>
              {threadId == null ? null : (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Open ${task.title} thread`}
                  render={
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId: props.environmentId, threadId }}
                    />
                  }
                >
                  <MessageSquareIcon />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
