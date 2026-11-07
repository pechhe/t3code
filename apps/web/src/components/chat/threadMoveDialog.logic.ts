export interface ThreadMoveTarget {
  readonly environmentId: string;
  readonly label: string;
  readonly reason: string | null;
}

export interface ThreadMoveDialogCopy {
  readonly title: string;
  readonly description: string;
  readonly canMove: boolean;
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
    };
  }
  if (input.options === undefined) {
    return { title: ask, description: `Checking ${target.label}…`, canMove: false };
  }
  if (input.options === "failed") {
    return {
      title: refused,
      description: `${sourceLabel} could not check its linked machines. Try again.`,
      canMove: false,
    };
  }
  const option = input.options.find((each) => each.environmentId === target.environmentId);
  if (option === undefined) {
    return {
      title: refused,
      description: `${target.label} isn't linked to ${sourceLabel}, or didn't answer. Link the two with full access in Settings → Connections, then try again.`,
      canMove: false,
    };
  }
  if (option.reason !== null) {
    return { title: refused, description: option.reason, canMove: false };
  }
  return {
    title: ask,
    description: `The conversation and its work, including uncommitted and unpushed changes, continue in a new thread on ${target.label}. This copy becomes read-only, with a link to the new one.`,
    canMove: true,
  };
}
