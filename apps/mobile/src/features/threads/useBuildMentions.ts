import { presentBuildWorkItem } from "@t3tools/client-runtime/state/build-work-items";
import type { BuildWorkItemView, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { findBuildMentions, labelBuildMentions } from "@t3tools/shared/buildLinks";
import { useMemo } from "react";

import { buildWorkItems } from "../../state/build-work-items";
import { useEnvironmentQuery } from "../../state/query";
import { buildMentionLabel } from "./build-work-item-subtitle";

/** The HQ whose Build links the thread's messages show as live items; null without one. */
export function useThreadBuildOrigin(environmentId: EnvironmentId, threadId: ThreadId | null) {
  return (
    useEnvironmentQuery(
      threadId === null ? null : buildWorkItems.connection({ environmentId, input: {} }),
    ).data?.origin ?? null
  );
}

const MAY_MENTION_BUILD = /#[1-9]\d{6}|\/build\//u;
const NO_MENTIONS: ReadonlyArray<BuildWorkItemView> = [];

/** The Build items a message mentions, read while it is mounted; the feed mounts what is shown. */
export function useBuildMentions(
  markdown: string,
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
) {
  const mayMention = threadId !== null && MAY_MENTION_BUILD.test(markdown);
  const origin = useThreadBuildOrigin(environmentId, mayMention ? threadId : null);
  const numbers = useMemo(
    () =>
      origin === null
        ? []
        : [...new Set(findBuildMentions(markdown, origin).map((mention) => mention.number))].slice(
            0,
            50,
          ),
    [markdown, origin],
  );
  const items =
    useEnvironmentQuery(
      threadId === null || numbers.length === 0
        ? null
        : buildWorkItems.mentions({ environmentId, input: { threadId, numbers } }),
    ).data?.items ?? NO_MENTIONS;
  return { origin, items };
}

/**
 * Native markdown is one text view, so a mention becomes a link labelled with the item's live
 * title and status. A mention Build doesn't know, or hasn't answered for yet, stays as written.
 */
export function useLiveBuildMentions(
  markdown: string,
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): string {
  const { origin, items } = useBuildMentions(markdown, environmentId, threadId);
  return useMemo(() => {
    if (origin === null || items.length === 0) return markdown;
    const labels = new Map(
      items.flatMap((view) =>
        view.item === null ? [] : [[view.number, buildMentionLabel(presentBuildWorkItem(view))]],
      ),
    );
    return labelBuildMentions(markdown, origin, (number) => labels.get(number));
  }, [items, markdown, origin]);
}
