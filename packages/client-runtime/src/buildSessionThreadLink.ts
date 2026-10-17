import type { BuildWorkItemSession } from "@t3tools/contracts";
import { parseThreadLink } from "@t3tools/shared/threadLinks";

/** Build's T3 session references name an environment and thread, separated by one slash. */
export function buildSessionThreadLink(session: BuildWorkItemSession | null) {
  if (session?.harness !== "t3") return null;
  const parts = session.sessionRef.split("/");
  const [environmentId, threadId] = parts;
  if (
    parts.length !== 2 ||
    !environmentId ||
    !threadId ||
    parts.some((part) => /[\s?#]/.test(part))
  )
    return null;
  const link = parseThreadLink(
    `t3-thread://v1/${threadId}?environment=${encodeURIComponent(environmentId)}`,
  );
  return link?.environmentId
    ? { environmentId: link.environmentId, threadId: link.threadId }
    : null;
}
