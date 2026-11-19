import { msg } from "gt-react";
import type { MessageResolver } from "../../i18n/messages";
import { TriangleAlertIcon } from "lucide-react";

import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Git is a supported choice: only a project set to SlipJay is nudged to convert. */
export function gitProjectBannerItem(input: {
  readonly isGitRepo: boolean | undefined;
  readonly isSlipJay: boolean | undefined;
  readonly versionControl: string | undefined;
  readonly resolve: MessageResolver;
}): ComposerBannerStackItem | null {
  const { resolve } = input;
  return input.isGitRepo === true && input.isSlipJay === false && input.versionControl === "slipjay"
    ? {
        id: "git-project",
        variant: "warning",
        icon: <TriangleAlertIcon />,
        title: resolve(msg("This is a Git project")),
        description: resolve(
          msg(
            "Set to SlipJay, so it should convert to Jujutsu. Change it in Source control settings.",
          ),
        ),
      }
    : null;
}
