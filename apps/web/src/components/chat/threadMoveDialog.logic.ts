export interface ThreadMoveTarget {
  readonly environmentId: string;
  readonly label: string;
  readonly reason: string | null;
  /** Projects there that fit this thread equally; the person picks one. */
  readonly candidates?:
    | ReadonlyArray<{ readonly projectId: string; readonly title: string }>
    | undefined;
  /** Delegated tasks still working, which the move asks to wrap up and hand off first. */
  readonly wrapsUp?: number | undefined;
}

/** One "Continue on…" choice as a menu id: the environment, and the project there when it is named. */
export function handoffChoiceId(target: {
  readonly environmentId: string;
  readonly projectId?: string | undefined;
}): string {
  return target.projectId === undefined
    ? target.environmentId
    : `${target.environmentId}|${target.projectId}`;
}

export function parseHandoffChoice(choice: string): {
  readonly environmentId: string;
  readonly projectId: string | undefined;
} {
  const split = choice.indexOf("|");
  return split < 0
    ? { environmentId: choice, projectId: undefined }
    : { environmentId: choice.slice(0, split), projectId: choice.slice(split + 1) };
}

export interface ThreadMoveDialogCopy {
  readonly title: string;
  readonly description: string;
  readonly canMove: boolean;
  /** The thread is mid-turn: moving it stops that turn first. */
  readonly stopsTurn: boolean;
  /** Delegated tasks the move asks to wrap up first. */
  readonly wrapsUp: number;
  /** Projects to choose between before the move can start. */
  readonly choices: ReadonlyArray<{ readonly projectId: string; readonly title: string }>;
}

/**
 * What the machine switch's move dialog says about moving a thread from
 * `sourceLabel` to `target`. `options` is undefined while the thread's machine
 * is still asking its linked machines, and "failed" when it could not answer.
 */
export function threadMoveDialogCopy(input: {
  readonly sourceLabel: string;
  readonly target: { readonly environmentId: string; readonly label: string };
  readonly running: boolean;
  readonly options: ReadonlyArray<ThreadMoveTarget> | "failed" | undefined;
}): ThreadMoveDialogCopy {
  const { sourceLabel, target } = input;
  const ask = `Move this thread to ${target.label}?`;
  const refused = `Can't move this thread to ${target.label}`;
  const stopsTurn = input.running;
  const closed = { canMove: false, stopsTurn, wrapsUp: 0, choices: [] };
  if (input.options === undefined) {
    return { title: ask, description: `Checking ${target.label}…`, ...closed };
  }
  if (input.options === "failed") {
    return {
      title: refused,
      description: `${sourceLabel} could not check its linked machines. Try again.`,
      ...closed,
    };
  }
  const option = input.options.find((each) => each.environmentId === target.environmentId);
  if (option === undefined) {
    return {
      title: refused,
      description: `${target.label} isn't linked to ${sourceLabel}, or didn't answer. Link the two with full access in Settings → Connections, then try again.`,
      ...closed,
    };
  }
  if (option.reason !== null) {
    return { title: refused, description: option.reason, ...closed };
  }
  const wrapsUp = option.wrapsUp ?? 0;
  const tasks = wrapsUp === 1 ? "1 delegated task" : `${wrapsUp} delegated tasks`;
  const wrapUp =
    wrapsUp === 0
      ? ""
      : `${tasks} still working here ${wrapsUp === 1 ? "is" : "are"} asked to wrap up and hand off first, and the thread moves with ${wrapsUp === 1 ? "its handoff" : "their handoffs"}. `;
  if (option.candidates !== undefined && option.candidates.length > 0) {
    return {
      title: ask,
      description: `${wrapUp}Several projects on ${target.label} have this repository. Choose which one continues the thread${stopsTurn ? "; its running turn stops first" : ""}.`,
      canMove: false,
      stopsTurn,
      wrapsUp,
      choices: option.candidates,
    };
  }
  return {
    title: ask,
    description: `${stopsTurn ? "This thread is mid-turn: moving it stops the turn here first. " : ""}${wrapUp}The conversation and its work, including uncommitted and unpushed changes, continue in a new thread on ${target.label}. This copy is archived here, and the new one opens in its place.`,
    canMove: true,
    stopsTurn,
    wrapsUp,
    choices: [],
  };
}
