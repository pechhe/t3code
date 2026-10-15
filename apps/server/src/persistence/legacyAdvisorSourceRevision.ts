/** Upgrade the old persisted advisor pin on read, keeping historical event bytes intact. */
export function normalizeFollowupSourceRevision(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("advisorSourceRevision" in payload))
    return payload;
  const { advisorSourceRevision, ...current } = payload;
  return "followupSourceRevision" in current
    ? current
    : { ...current, followupSourceRevision: advisorSourceRevision };
}
