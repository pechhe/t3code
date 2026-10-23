/**
 * Which T3 thread a FluidVoice conversation is talking to.
 *
 * The bridge keeps this on disk so a Command session that spans an app restart
 * keeps its thread, and prunes what nobody has touched for a week so the file
 * cannot grow without bound.
 */

export type VoiceSession = {
  readonly threadId: string;
  readonly updatedAt: number;
};

export type SessionStore = {
  readonly version: 1;
  readonly entries: Readonly<Record<string, VoiceSession>>;
};

export const EMPTY_SESSIONS: SessionStore = { version: 1, entries: {} };

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_ENTRIES = 200;

export function threadFor(store: SessionStore, key: string): string | null {
  return store.entries[key]?.threadId ?? null;
}

export function rememberThread(
  store: SessionStore,
  key: string,
  threadId: string,
  now: number,
): SessionStore {
  return {
    version: 1,
    entries: { ...store.entries, [key]: { threadId, updatedAt: now } },
  };
}

/** Drops sessions nobody has used recently, then the oldest beyond the cap. */
export function pruneSessions(store: SessionStore, now: number): SessionStore {
  const live = Object.entries(store.entries).filter(([, entry]) => now - entry.updatedAt <= MAX_AGE_MS);
  live.sort((left, right) => right[1].updatedAt - left[1].updatedAt);
  return { version: 1, entries: Object.fromEntries(live.slice(0, MAX_ENTRIES)) };
}

/** Reads a store written by an older or broken file as an empty one. */
export function decodeSessions(value: unknown): SessionStore {
  if (typeof value !== "object" || value === null) return EMPTY_SESSIONS;
  const entries = (value as { entries?: unknown }).entries;
  if (typeof entries !== "object" || entries === null) return EMPTY_SESSIONS;
  const decoded: Record<string, VoiceSession> = {};
  for (const [key, raw] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const { threadId, updatedAt } = raw as { threadId?: unknown; updatedAt?: unknown };
    if (typeof threadId !== "string" || threadId === "") continue;
    decoded[key] = { threadId, updatedAt: typeof updatedAt === "number" ? updatedAt : 0 };
  }
  return { version: 1, entries: decoded };
}
