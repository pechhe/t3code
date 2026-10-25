import type { MenuAction } from "@react-native-menu/menu";
import { forgeItemLabel } from "@t3tools/client-runtime/state/forge-work-items";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import { useCallback, useMemo } from "react";
import { Linking } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import {
  forgeWorkItems,
  useForgeConnected,
  useThreadForgeWorkItem,
} from "../../state/forge-work-items";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * A thread row's Build link actions, offered only when its environment is connected to
 * YardSmith HQ: link one, or open, change and unlink the linked Forge item.
 */
export function useThreadForgeMenu(thread: EnvironmentThreadShell) {
  const connected = useForgeConnected(thread.environmentId);
  const link = useAtomCommand(forgeWorkItems.link, { reportFailure: false });
  const workItem = thread.workItem ?? null;
  const ref = useThreadForgeWorkItem(thread)?.item?.ref;

  const items = useMemo<MenuAction[]>(
    () =>
      !connected
        ? []
        : workItem === null
          ? [{ id: "build-link", title: "Link Build item", image: "link" }]
          : [
              {
                id: "build-item",
                title: `Build ${forgeItemLabel({ number: workItem.number, ref })}`,
                image: "link",
                subactions: [
                  { id: "build-open", title: "Open in Weave", image: "safari" },
                  { id: "build-link", title: "Change…", image: "pencil" },
                  {
                    id: "build-unlink",
                    title: "Unlink",
                    image: "link.badge.minus",
                    attributes: { destructive: true },
                  },
                ],
              },
            ],
    [connected, workItem, ref],
  );

  const setLink = useCallback(
    (reference: string | null) =>
      void link({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, reference },
      }).then((result) => {
        if (result._tag === "Success") return;
        const error = Cause.squash(result.cause);
        Dialog.alert(
          reference === null ? "Could not unlink Build item" : "Could not link Build item",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The Build link could not be changed.",
        );
      }),
    [link, thread.environmentId, thread.id],
  );

  /** Handles a Build menu event; false for any other event. */
  const handle = useCallback(
    (event: string) => {
      switch (event) {
        case "build-link":
          Dialog.prompt({
            title: "Build URL, ref (YS-12) or #number",
            initialValue: "",
            confirmText: "Link",
            onConfirm: (reference) => {
              if (reference.trim().length > 0) setLink(reference.trim());
            },
          });
          return true;
        case "build-unlink":
          setLink(null);
          return true;
        case "build-open":
          if (workItem !== null)
            void Linking.openURL(`${workItem.origin}/build/${workItem.number}`).catch(
              () => undefined,
            );
          return true;
        default:
          return false;
      }
    },
    [setLink, workItem],
  );

  return { items, handle };
}
