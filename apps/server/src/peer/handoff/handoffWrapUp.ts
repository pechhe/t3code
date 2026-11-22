import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadHandoffWrapUp,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

/** How long a move waits for its delegated tasks to hand off before it stops the rest. */
export const WRAP_UP_BOUND = Duration.minutes(10);

/** The most of one task's handoff the moved thread's notice carries. */
const HANDOFF_CHARS = 6_000;

type Task = Pick<
  OrchestrationV2Subagent,
  "id" | "origin" | "status" | "childThreadId" | "remoteChild" | "nativeTaskRef"
>;

/** The thread's delegated tasks still working: each is asked to wrap up before the thread moves. */
export const workingTasks = <T extends Task>(subagents: ReadonlyArray<T>): ReadonlyArray<T> =>
  subagents.filter(
    (task) =>
      task.origin === "app_owned" &&
      isOrchestrationV2WorkActive(task.status) &&
      (task.childThreadId !== null || task.remoteChild !== undefined),
  );

/**
 * The thread's background work without its delegated tasks, which a move wraps up instead of
 * refusing. A task shows in it by its child thread, or, when it runs on another machine, by the
 * id of its subagent turn item.
 */
export const backgroundWorkBesides = (
  pending: NonNullable<OrchestrationV2ThreadShell["pendingBackgroundTasks"]>,
  subagents: ReadonlyArray<Task>,
  taskItems: ReadonlyArray<Pick<OrchestrationV2TurnItem, "id" | "nodeId">> = [],
): NonNullable<OrchestrationV2ThreadShell["pendingBackgroundTasks"]> => {
  const owned = subagents.filter((task) => task.origin === "app_owned");
  const children = new Set(
    owned.flatMap((task) => (task.childThreadId === null ? [] : [task.childThreadId])),
  );
  const ownedIds = new Set<string>(owned.map((task) => task.id));
  const ids = new Set([
    ...ownedIds,
    ...owned.flatMap((task) =>
      task.nativeTaskRef?.nativeId == null ? [] : [task.nativeTaskRef.nativeId],
    ),
    ...taskItems.flatMap((item) =>
      item.nodeId !== null && ownedIds.has(item.nodeId) ? [String(item.id)] : [],
    ),
  ]);
  return pending.filter(
    (work) =>
      work.kind !== "subagent" ||
      !(
        ("childThreadId" in work &&
          work.childThreadId !== undefined &&
          children.has(work.childThreadId)) ||
        ids.has(work.taskId)
      ),
  );
};

/** What a working task is told when the thread that delegated it is about to move. */
export const wrapUpRequest = (label: string) =>
  [
    `The thread that delegated this task is moving to ${label}. Wrap up now: stop at a safe point, and wrap up or stop any subagents of your own.`,
    "Then end your turn with a handoff the agent there can act on without you: what you did, what is left, where your work is (workspace, commit or branch, and whether it is pushed or landed), and anything it needs to know or decide.",
  ].join("\n\n");

/** What a task still working is told when the move it was wrapping up for is off. */
export const carryOnMessage =
  "The move is off: the thread that delegated this task is staying here. Carry on with your task as before.";

export const wrapUpOverdue = (
  wrapUp: OrchestrationV2ThreadHandoffWrapUp,
  now: DateTime.Utc,
  bound: Duration.Duration = WRAP_UP_BOUND,
) =>
  Duration.isGreaterThanOrEqualTo(
    DateTime.distance(DateTime.makeUnsafe(wrapUp.requestedAt), now),
    bound,
  );

/** The notice's account of each task asked to wrap up: its handoff, or that it had none. */
export const handoffsSection = (
  tasks: ReadonlyArray<
    Pick<OrchestrationV2Subagent, "title" | "prompt" | "status" | "result" | "progress">
  >,
  fromLabel: string,
): string | undefined => {
  if (tasks.length === 0) return undefined;
  const name = (task: (typeof tasks)[number]) =>
    task.title ?? (task.prompt.length > 80 ? `${task.prompt.slice(0, 80)}…` : task.prompt);
  const each = tasks.map((task) => {
    const result = task.result?.trim();
    if (task.status === "completed" && result !== undefined && result !== "") {
      const cut =
        result.length > HANDOFF_CHARS
          ? `${result.slice(0, HANDOFF_CHARS)}… (cut; the whole handoff is in the task's thread on ${fromLabel})`
          : result;
      return `### ${name(task)}\n\n${cut}`;
    }
    const last = task.progress?.trim();
    const why = isOrchestrationV2WorkActive(task.status)
      ? "Still working when the wait for its handoff ran out, so it was stopped."
      : `Ended ${task.status} without a handoff.`;
    return `### ${name(task)}\n\n${why}${last === undefined || last === "" ? "" : ` Its last progress: ${last}`}`;
  });
  return [
    `Before the move, its delegated tasks were asked to wrap up and hand off. Their handoffs follow; their threads stay on ${fromLabel}. Hand out again whatever is left.`,
    ...each,
  ].join("\n\n");
};
