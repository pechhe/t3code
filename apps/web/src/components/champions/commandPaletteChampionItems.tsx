import { ShieldCheckIcon } from "lucide-react";
import { msg } from "gt-react";
import type { MessageResolver } from "../../i18n/messages";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";

export function buildChampionsItem(input: {
  readonly resolve: MessageResolver;
  readonly openChampions: () => Promise<unknown>;
}): CommandPaletteActionItem {
  const { resolve, openChampions } = input;
  return {
    kind: "action",
    value: "action:champions",
    searchTerms: ["champions", "champion", "metrics", "health", "quality", "monitor", "findings"],
    title: resolve(msg("Open champions")),
    icon: <ShieldCheckIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await openChampions();
    },
  };
}
