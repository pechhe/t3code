/** A thread move as the open thread's banner sees it; `there` is where it went, once it has and this client can open it. */
export interface WatchedMove<There> {
  readonly threadId: string;
  readonly moving: boolean;
  readonly there: There | null;
}

/**
 * Which thread to open as a move finishes: the thread there, but only for the open thread this
 * client saw moving, so opening an old moved thread later shows it rather than jumping away.
 */
export function followMovedThread<There>(
  seenMoving: string | null,
  move: WatchedMove<There>,
): { readonly seenMoving: string | null; readonly open: There | null } {
  if (move.moving) return { seenMoving: move.threadId, open: null };
  if (move.there !== null && seenMoving === move.threadId) {
    return { seenMoving: null, open: move.there };
  }
  return { seenMoving, open: null };
}
