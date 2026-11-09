export interface ThreadMoveTarget {
  readonly environmentId: string;
  readonly label: string;
  readonly reason: string | null;
  /** Projects there that fit this thread equally; the person picks one. */
  readonly candidates?:
    | ReadonlyArray<{ readonly projectId: string; readonly title: string }>
    | undefined;
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
  if (input.running) {
    return {
      title: ask,
      description: "A thread moves between turns. Wait for this one to finish, or stop it.",
      canMove: false,
      choices: [],
    };
  }
  if (input.options === undefined) {
    return { title: ask, description: `Checking ${target.label}…`, canMove: false, choices: [] };
  }
  if (input.options === "failed") {
    return {
      title: refused,
      description: `${sourceLabel} could not check its linked machines. Try again.`,
      canMove: false,
      choices: [],
    };
  }
  const option = input.options.find((each) => each.environmentId === target.environmentId);
  if (option === undefined) {
    return {
      title: refused,
      description: `${target.label} isn't linked to ${sourceLabel}, or didn't answer. Link the two with full access in Settings → Connections, then try again.`,
      canMove: false,
      choices: [],
    };
  }
  if (option.reason !== null) {
    return { title: refused, description: option.reason, canMove: false, choices: [] };
  }
  if (option.candidates !== undefined && option.candidates.length > 0) {
    return {
      title: ask,
      description: `Several projects on ${target.label} have this repository. Choose which one continues the thread.`,
      canMove: false,
      choices: option.candidates,
    };
  }
  return {
    title: ask,
    description: `The conversation and its work, including uncommitted and unpushed changes, continue in a new thread on ${target.label}. This copy becomes read-only, with a link to the new one.`,
    canMove: true,
    choices: [],
  };
}
