import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const THREAD_LINK_PROTOCOL = "t3-thread";
const THREAD_LINK_HREF_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
// Code comes first in the alternation so a link written inside a code span or fence is skipped.
const THREAD_LINK_OUTSIDE_CODE =
  /(?<fence>(`{3,}|~{3,})[\s\S]*?(?:\2|$))|(?<span>(`+)[^\n]*?\4)|\[[^\]\n]*\]\((?<href>t3-thread:\/\/v1\/[^\s)]+)\)/g;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const ENVIRONMENT_QUALIFIER = "environment";

export interface ThreadLink {
  /** As written. Thread ids can hold percent escapes of their own, so it is not decoded. */
  readonly threadId: ThreadId;
  /** The environment the thread lives in; null means the environment of the message holding the link. */
  readonly environmentId: EnvironmentId | null;
}

/** Null when the href is not a thread link, or its environment qualifier is not an environment id. */
export function parseThreadLink(href: string): ThreadLink | null {
  if (!href.startsWith(THREAD_LINK_HREF_PREFIX)) return null;
  const rest = href.slice(THREAD_LINK_HREF_PREFIX.length);
  const queryStart = rest.indexOf("?");
  const threadId = Option.getOrNull(
    decodeThreadId(queryStart === -1 ? rest : rest.slice(0, queryStart)),
  );
  if (threadId === null) return null;
  if (queryStart === -1) return { threadId, environmentId: null };
  const qualifier = new URLSearchParams(rest.slice(queryStart + 1)).get(ENVIRONMENT_QUALIFIER);
  if (qualifier === null) return { threadId, environmentId: null };
  const environmentId = Option.getOrNull(decodeEnvironmentId(qualifier));
  return environmentId === null ? null : { threadId, environmentId };
}

/** The thread a link names, whichever environment it is in. */
export function parseThreadLinkHref(href: string): ThreadId | null {
  return parseThreadLink(href)?.threadId ?? null;
}

export function percentDecodedThreadLinkId(threadId: ThreadId): ThreadId | null {
  try {
    const decoded = decodeURIComponent(threadId);
    return decoded === threadId ? null : Option.getOrNull(decodeThreadId(decoded));
  } catch {
    return null;
  }
}

/**
 * A thread link whose label survives Markdown: no brackets, backslashes, or line breaks. Pass the
 * environment only for a thread outside the environment of the message that will hold the link.
 */
export function formatThreadLink(
  threadId: string,
  label: string,
  environmentId?: EnvironmentId | null,
): string {
  const cleaned = label
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const qualifier = environmentId
    ? `?${ENVIRONMENT_QUALIFIER}=${encodeURIComponent(environmentId)}`
    : "";
  return `[${cleaned || threadId}](${THREAD_LINK_HREF_PREFIX}${threadId}${qualifier})`;
}

export function hasThreadLinks(markdown: string): boolean {
  return markdown.includes(`](${THREAD_LINK_HREF_PREFIX}`);
}

export function relabelThreadLinks(
  markdown: string,
  title: (threadId: ThreadId) => string | undefined,
): string {
  if (!hasThreadLinks(markdown)) return markdown;
  return markdown.replace(THREAD_LINK_OUTSIDE_CODE, (source, ...args) => {
    const href = (args.at(-1) as { href?: string }).href;
    if (href === undefined) return source;
    const link = parseThreadLink(href);
    if (link === null || link.environmentId !== null) return source;
    const written = link.threadId;
    // The decoded id only stands in when the id as written names no thread.
    const decoded = percentDecodedThreadLinkId(written);
    const threadId =
      title(written) === undefined && decoded !== null && title(decoded) !== undefined
        ? decoded
        : written;
    const label = title(threadId)?.trim();
    return label ? formatThreadLink(threadId, label) : source;
  });
}
