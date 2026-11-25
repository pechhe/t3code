// @ts-nocheck -- vendored pi-blackhole source, type-checked upstream under its own settings.
// T3 replacement for upstream's JSONL session reader: a T3 thread is never a file, so
// recall scans the synthetic session T3 registers for the call (see ../../session.ts).
export interface SessionScanResult {
  missing: boolean;
  parseErrors: number;
}

const virtualSessions = new Map<string, readonly unknown[]>();

export const registerVirtualSession = (key: string, entries: readonly unknown[]): (() => void) => {
  virtualSessions.set(key, entries);
  return () => {
    if (virtualSessions.get(key) === entries) virtualSessions.delete(key);
  };
};

export const isVirtualSession = (key: string): boolean => virtualSessions.has(key);

export const scanSessionEntries = (
  sessionFile: string,
  onEntry: (entry: any) => void,
): SessionScanResult => {
  const entries = virtualSessions.get(sessionFile);
  if (entries === undefined) return { missing: true, parseErrors: 0 };
  for (const entry of entries) onEntry(entry);
  return { missing: false, parseErrors: 0 };
};
