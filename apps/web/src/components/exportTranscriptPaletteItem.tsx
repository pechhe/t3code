import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { DownloadIcon } from "lucide-react";
import { msg } from "gt-react";
import type { MessageResolver } from "../i18n/messages";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";
import { openExportTranscriptDialog } from "./ExportTranscriptDialog";

export function buildExportTranscriptItem(input: {
  readonly resolve: MessageResolver;
  readonly thread: EnvironmentThreadShell;
}): CommandPaletteActionItem {
  const { resolve, thread } = input;
  return {
    kind: "action",
    value: "action:export-transcript",
    searchTerms: ["export", "transcript", "copy", "markdown", "download", "review"],
    title: resolve(msg("Export transcript…")),
    icon: <DownloadIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      openExportTranscriptDialog(scopeThreadRef(thread.environmentId, thread.id));
    },
  };
}
