import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { environmentSummaries } from "./presentation";
import { formatEnvironmentQueryError } from "./query";
import { serverEnvironment } from "./server";

export interface EnvironmentScheduledTasks {
  readonly environmentId: EnvironmentId;
  /** Null until the machine's list arrives. */
  readonly tasks: ReadonlyArray<ScheduledTask> | null;
  readonly error: string | null;
  /** The machine's IANA zone, which fixed-time schedules run in. */
  readonly timeZone: string | undefined;
}

/** Every connected machine's live task list; the Scheduled page and sidebar share it. */
export const allScheduledTasksAtom = Atom.make((get): ReadonlyArray<EnvironmentScheduledTasks> =>
  get(environmentSummaries.connectedEnvironmentIdsAtom).map((environmentId) => {
    const result = get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} }));
    const value = Option.getOrNull(AsyncResult.value(result));
    return {
      environmentId,
      tasks: value?.tasks ?? null,
      timeZone: value?.timeZone,
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    };
  }),
).pipe(Atom.withLabel("web-scheduled-tasks:all"));

export function useAllScheduledTasks() {
  return useAtomValue(allScheduledTasksAtom);
}

const SEEN_FAILURES_KEY = "t3code:scheduled-tasks:seen-failures:v1";
const SeenFailuresSchema = Schema.Record(Schema.String, Schema.String);
const NO_SEEN_FAILURES: Readonly<Record<string, string>> = {};

/** Failed runs this browser has opened, so the sidebar counts only new ones. */
export function useSeenScheduledFailures() {
  return useLocalStorage(SEEN_FAILURES_KEY, NO_SEEN_FAILURES, SeenFailuresSchema);
}
