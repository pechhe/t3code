import type { UnifiedSettings } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { msg } from "gt-react";

import type { MessageResolver } from "../../i18n/messages";

type InterfaceFeelSettings = Pick<
  UnifiedSettings,
  "interfaceSounds" | "sendMotion" | "sendSound" | "queueSound" | "settleSound" | "composerFinish"
>;

/** The fork's sounds, send motion and composer finish, as Restore defaults resets them. */
export const INTERFACE_FEEL_SETTING_DEFAULTS: InterfaceFeelSettings = {
  interfaceSounds: DEFAULT_UNIFIED_SETTINGS.interfaceSounds,
  sendMotion: DEFAULT_UNIFIED_SETTINGS.sendMotion,
  sendSound: DEFAULT_UNIFIED_SETTINGS.sendSound,
  queueSound: DEFAULT_UNIFIED_SETTINGS.queueSound,
  settleSound: DEFAULT_UNIFIED_SETTINGS.settleSound,
  composerFinish: DEFAULT_UNIFIED_SETTINGS.composerFinish,
};

export function getChangedInterfaceFeelSettingLabels(
  settings: InterfaceFeelSettings,
  resolve: MessageResolver,
): string[] {
  return [
    ...(settings.interfaceSounds !== DEFAULT_UNIFIED_SETTINGS.interfaceSounds
      ? [resolve(msg("Interface sounds"))]
      : []),
    ...(settings.sendMotion !== DEFAULT_UNIFIED_SETTINGS.sendMotion
      ? [resolve(msg("Send motion"))]
      : []),
    ...(settings.sendSound !== DEFAULT_UNIFIED_SETTINGS.sendSound
      ? [resolve(msg("Send sound"))]
      : []),
    ...(settings.queueSound !== DEFAULT_UNIFIED_SETTINGS.queueSound
      ? [resolve(msg("Queue sound"))]
      : []),
    ...(settings.settleSound !== DEFAULT_UNIFIED_SETTINGS.settleSound
      ? [resolve(msg("Settle sound"))]
      : []),
    ...(settings.composerFinish !== DEFAULT_UNIFIED_SETTINGS.composerFinish
      ? [resolve(msg("Composer finish"))]
      : []),
  ];
}
