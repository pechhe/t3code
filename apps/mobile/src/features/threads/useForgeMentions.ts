import { presentForgeWorkItem } from "@t3tools/client-runtime/state/forge-work-items";
import type { ForgeWorkItemView, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { findForgeMentions, labelForgeMentions } from "@t3tools/shared/forgeLinks";
import { useMemo } from "react";

import { forgeWorkItems } from "../../state/forge-work-items";
import { useEnvironmentQuery } from "../../state/query";
import { forgeMentionLabel } from "./build-work-item-subtitle";

/** The HQ whose Build links the thread's messages show as live items; null without one. */
export function useThreadForgeOrigin(environmentId: EnvironmentId, threadId: ThreadId | null) {
  return (
    useEnvironmentQuery(
      threadId === null ? null : forgeWorkItems.connection({ environmentId, input: {} }),
    ).data?.origin ?? null
  );
}

const MAY_MENTION_BUILD = /#[1-9]\d{6}|\/build\//u;
const NO_MENTIONS: ReadonlyArray<ForgeWorkItemView> = [];

/** The Build items a message mentions, read while it is mounted; the feed mounts what is shown. */
export function useForgeMentions(
  markdown: string,
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
) {
  const mayMention = threadId !== null && MAY_MENTION_BUILD.test(markdown);
  const origin = useThreadForgeOrigin(environmentId, mayMention ? threadId : null);
  const numbers = useMemo(
    () =>
      origin === null
        ? []
        : [...new Set(findForgeMentions(markdown, origin).map((mention) => mention.number))].slice(
            0,
            50,
          ),
    [markdown, origin],
  );
  const items =
    useEnvironmentQuery(
      threadId === null || numbers.length === 0
        ? null
        : forgeWorkItems.mentions({ environmentId, input: { threadId, numbers } }),
    ).data?.items ?? NO_MENTIONS;
  return { origin, items };
}

/**
 * Native markdown is one text view, so a mention becomes a link labelled with the item's live
 * title and status. A mention Build doesn't know, or hasn't answered for yet, stays as written.
 */
export function useLiveForgeMentions(
  markdown: string,
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): string {
  const { origin, items } = useForgeMentions(markdown, environmentId, threadId);
  return useMemo(() => {
    if (origin === null || items.length === 0) return markdown;
    const labels = new Map(
      items.flatMap((view) =>
        view.item === null ? [] : [[view.number, forgeMentionLabel(presentForgeWorkItem(view))]],
      ),
    );
    return labelForgeMentions(markdown, origin, (number) => labels.get(number));
  }, [items, markdown, origin]);
}
