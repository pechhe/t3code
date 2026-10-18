import { useAtomValue } from "@effect/atom-react";
import { isModifierPairShortcut, type SnapShotShortcut } from "@t3tools/contracts";
import { useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { getDesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import { sameSnapShotShortcut, snapShotKeybindingConflict } from "../../lib/snapShotShortcut";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { commandLabel } from "./KeybindingsSettings.logic";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";

/**
 * The shortcut that hides the SnapShot overlay's conversation and brings it back. A recorded
 * shortcut saves as soon as it checks out, since nothing else waits on it.
 */
export function SnapShotOverlayShortcutRow({ disabled }: { readonly disabled: boolean }) {
  const settings = useClientSettings((current) => ({
    capture: current.snapShotShortcut,
    overlay: current.snapShotOverlayShortcut,
  }));
  const updateSettings = useUpdateClientSettings();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [message, setMessage] = useState<string | null>(null);

  const record = async (shortcut: SnapShotShortcut) => {
    if (isModifierPairShortcut(shortcut) || sameSnapShotShortcut(shortcut, settings.overlay)) {
      return;
    }
    if (sameSnapShotShortcut(shortcut, settings.capture)) {
      setMessage("This is your capture shortcut.");
      return;
    }
    const conflict = snapShotKeybindingConflict(shortcut, keybindings);
    if (conflict) {
      setMessage(`T3 Code already uses this for "${commandLabel(conflict)}".`);
      return;
    }
    try {
      const availability = await getDesktopSnapShotBridge()?.checkSnapShotShortcut(shortcut);
      if (availability && !availability.available) {
        setMessage(availability.message);
        return;
      }
      await updateSettings({ snapShotOverlayShortcut: shortcut });
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save this shortcut.");
    }
  };

  const { recording, input } = useSnapShotShortcutRecorder({
    name: "show or hide shortcut",
    shortcut: settings.overlay,
    disabled,
    allowModifierPairs: false,
    onRecord: (shortcut) => void record(shortcut),
    onStart: () => setMessage(null),
    onError: setMessage,
  });

  return (
    <SettingsRow
      {...searchableSetting("snap-shot-overlay-shortcut")}
      description="Hide the snapshot conversation, or bring it back, without taking a snapshot."
      status={recording ? "Press your shortcut. Esc cancels." : (message ?? undefined)}
      control={input}
    />
  );
}
