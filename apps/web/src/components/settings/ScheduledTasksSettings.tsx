import type { EnvironmentId, ScheduledTaskId } from "@t3tools/contracts";
import { ScheduledTasksPage } from "../scheduled/ScheduledTasksPage";

export function ScheduledTasksSettings(target: {
  readonly environmentId?: EnvironmentId | undefined;
  readonly taskId?: ScheduledTaskId | undefined;
}) {
  return <ScheduledTasksPage {...target} />;
}
