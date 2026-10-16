import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { type RefObject, useEffect, useSyncExternalStore } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { readThreadShells } from "../../state/entities";

export const THREAD_CONTEXT_DROP_EVENT = "t3-thread-context-drop";

export function useThreadContextDrop(
  targetRef: RefObject<EventTarget | null>,
  environmentId: EnvironmentId,
  targetKey: string,
  onDrop: (refs: ReadonlyArray<ScopedThreadRef>, isActive: () => boolean) => void,
) {
  // useEffectEvent kept the first render's composer here, so a drop on a reused composer
  // attached to the thread it was first mounted for.
  const handleDrop = useStableCallback(onDrop);
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let active = true;
    const listener = (event: Event) =>
      handleDrop((event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail, () => active);
    target.addEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    return () => {
      active = false;
      target.removeEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    };
  }, [environmentId, handleDrop, targetKey, targetRef]);
}

const DROP_TARGET_ATTRIBUTE = "data-thread-context-drop";
const DROP_OVER_ATTRIBUTE = "data-thread-context-over";

export interface ThreadContextDragGhost {
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly count: number;
}

let ghost: ThreadContextDragGhost | null = null;
const listeners = new Set<() => void>();

function setGhost(next: ThreadContextDragGhost | null) {
  if (ghost === next) return;
  ghost = next;
  for (const listener of listeners) listener();
}

export function useThreadContextDragGhost(): ThreadContextDragGhost | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ghost,
    () => null,
  );
}

let overTarget: HTMLElement | null = null;

function findDropTarget(point: { x: number; y: number }): HTMLElement | null {
  return (
    document
      .elementFromPoint(point.x, point.y)
      ?.closest<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`) ?? null
  );
}

export function moveThreadContextDrag(
  point: { x: number; y: number },
  label: { title: string; count: number },
) {
  const target = findDropTarget(point);
  if (target !== overTarget) {
    overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
    target?.setAttribute(DROP_OVER_ATTRIBUTE, "true");
    overTarget = target;
  }
  setGhost({ x: point.x, y: point.y, ...label });
}

export function endThreadContextDrag() {
  overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
  overTarget = null;
  setGhost(null);
}

export function dropThreadContext(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
): boolean {
  return handToComposer(findDropTarget(point), threads);
}

/** Hands threads to the composer on screen, as a drop would. False when no composer is open. */
export function attachThreadsToComposer(threads: ReadonlyArray<ScopedThreadRef>): boolean {
  return handToComposer(document.querySelector<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`), threads);
}

function handToComposer(
  target: HTMLElement | null,
  threads: ReadonlyArray<ScopedThreadRef>,
): boolean {
  if (!target || threads.length === 0) return false;
  target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: threads }));
  return true;
}

export function threadContextDropTargetProps() {
  return { [DROP_TARGET_ATTRIBUTE]: "true" } as const;
}

/**
 * Threads named by pasted text that is nothing but thread ids (what "Copy thread ID" puts on the
 * clipboard). Null when any token is not a known thread, so ordinary text pastes untouched. An
 * id known to several environments resolves to `preferredEnvironmentId` when it is one of them.
 */
export function resolvePastedThreadIds(
  text: string,
  preferredEnvironmentId: EnvironmentId,
): ScopedThreadRef[] | null {
  const ids = text.trim().split(/\s+/);
  if (ids.length === 0 || ids.length > 20 || ids[0] === "") return null;
  const shells = readThreadShells();
  const refs: ScopedThreadRef[] = [];
  for (const id of ids) {
    const matches = shells.filter((shell) => shell.id === id);
    const match = matches.find((m) => m.environmentId === preferredEnvironmentId) ?? matches[0];
    if (!match) return null;
    refs.push(scopeThreadRef(match.environmentId, match.id));
  }
  return refs;
}
